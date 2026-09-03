# 問い合わせAI管理センター / 社内LINE Bot通知(2026-09-03)

`BELLO_message_ai_linebot_implementation_spec.md` の実装記録。
何を作り、何を既存から再利用し、**何がまだ本人操作待ちなのか**を残す。

---

## 0. 最初に: 大原さんの操作が必要なもの

コードは全部入っているが、以下は本人にしかできないため未完了。
これが済むまで「実際にLINEへ届く」ところは検証できない。

### A. 社内通知用LINE Botの認証情報(必須)

1. [LINE Developers Console](https://developers.line.biz/console/) で社内通知用チャネルを開く
2. **Messaging API** タブ → チャネルアクセストークン(長期)を発行してコピー
3. **チャネル基本設定** タブ → チャネルシークレットをコピー
4. BELLO の `メッセージ ＞ LINE Bot` タブ → 「認証情報を設定」へ貼り付け
5. 同じ画面のQR(または友だち追加リンク)から、自分のLINEでBotを友だち追加

> 値をチャットやGitへ貼らない。保存先は AWS Secrets Manager `bello/line-notify-bot`。

**通知先ユーザーIDの手入力は不要。** 友だち追加(followイベント)で自動登録する。
そのためには LINE Developers Console のこのチャネルの Webhook URL に

```
https://claude-inventory-management-system-5vbvc7.d4hkkg7dty2du.amplifyapp.com/api/line/notify-webhook
```

を設定して有効化する。設定しない場合、通知先が登録されないため送信先が無い状態になる。

### B. メルカリShops通知メールの取り込み(メルカリ経路を使う場合のみ)

1. Google Cloud で OAuth クライアント(デスクトップアプリ)を作成
2. スコープ `https://www.googleapis.com/auth/gmail.readonly` で同意し、リフレッシュトークンを取得
3. BELLO の `メッセージ ＞ メール取込` タブへ クライアントID / シークレット / リフレッシュトークンを入力

保存先は Secrets Manager `bello/gmail-oauth`。

### C. IAMポリシーの追加1件(Gmailを使う場合のみ)

`bello/line-notify-bot` の権限は付与済み。`bello/gmail-oauth` は**未付与**
(作業中に権限操作がブロックされたため)。Gmail取り込みを使うときに以下を実行する。

```bash
aws iam get-role-policy --role-name BelloAmplifyStagingComputeRole \
  --policy-name BelloComputeRuntimeAccess --query PolicyDocument > pol.json
# pol.json の Sid=BelloMercariAndLineSecretAccess の Resource へ
#   arn:aws:secretsmanager:us-west-2:203918843421:secret:bello/gmail-oauth-??????
# を1行足してから
aws iam put-role-policy --role-name BelloAmplifyStagingComputeRole \
  --policy-name BelloComputeRuntimeAccess --policy-document file://pol.json
```

> `put-role-policy` はポリシー全体を**置換**する。必ず現在の内容を読んでから足すこと
> (`scripts/aws-setup/10-apply-compute-runtime-policy.ps1` は内容が古い。同ファイル冒頭の警告参照)。

### D. メルカリ通知メールのサンプル1通(精度を上げるため)

パーサは実物のサンプル無しで書いている(§14 は実物基準を求めている)。
1通あれば `scripts/verify-mercari-mail.ts` にケースとして足し、抽出精度を確定できる。

---

## 1. 既存から再利用したもの(作り直していない)

指示書§20「既存アルゴリズムの継承」に対する対応。**置換ではなく接続**にした。

| 機能 | 既存の実装 | 扱い |
|---|---|---|
| 公式LINE受信 | `app/api/line/webhook/route.ts` + `line/signature.ts` + `webhookStore.ts` | そのまま。末尾に解析・通知を足しただけ |
| 商品特定 | `lib/inquiry/productResolver.ts` / `references.ts` / `scoring.ts` / `productIdentification.ts` | そのまま呼ぶ |
| BASE商品URL解析 | `lib/inquiry/baseProductLookup.ts` | そのまま |
| 値下げ交渉判断 | `lib/inquiry/negotiation.ts` / `negotiationService.ts` / `discount.ts` | そのまま |
| 配送日ルール(2週間) | `lib/inquiry/deliveryWindow.ts` | そのまま。判定結果を【要確認】へ繋いだ |
| 送料計算 | `lib/shipping/service.ts` / `rank.ts` | そのまま |
| AI返信生成 | `lib/inquiry/pipeline.ts` / `prompt.ts` / `validate.ts` / `keigo.ts` | REPLY_RULES セクションを足しただけ |
| ナレッジDB | `KnowledgeDocument` + `lib/knowledge/*` + `KnowledgeSettingsPanel` | 画面ごと再利用 |
| 対象商品カード | `IdentifiedProductCardView`(477b6a6) | LINE通知の商品情報にもこの値を使う |
| Secret管理 | `lib/messaging/line/secretStore.ts` の方式 | 同じ方式で複製(用途が別なのでSecretは分ける) |

**Inquiry モデルを新設していない。** `Conversation` + `Message` が既に §9 の共通形式
(channel / externalConversationId / externalCustomerId / customerDisplayName /
relatedInventoryId / relatedBaseItemId / externalMessageId / 本文)を持っている。
もう1つ作ると同じ事実が2箇所に書かれ、どちらが正かが曖昧になる(§30 とも整合)。

---

## 2. 追加したもの

### モデル(`amplify/data/resource.ts`)

- `ReplyRule` — §16「どう判断するか」。ナレッジ(§19「判断に必要な情報」)とは別。削除はソフトデリート
- `NotificationDelivery` — §8 通知の配送状態。`dedupeKey` / `attemptCount` / `status`
- `LineNotifySettings` — §4-3/§6 通知先とQR。**トークンは入れない**
- `MessageChannel` に `BASE` を追加(既存値は不変)

### 社内通知(`lib/messaging/lineNotify/`)

| ファイル | 役割 |
|---|---|
| `format.ts` | §7 1通目/2通目の文面。純粋関数 |
| `reviewPolicy.ts` | §33 【要確認】の判定。純粋関数 |
| `deliveryPolicy.ts` | §8 再試行と打ち切り。純粋関数 |
| `client.ts` | LINE push。**顧客向けとは別の送信口** |
| `secretStore.ts` | `bello/line-notify-bot` |
| `deliveryStore.ts` / `settingsStore.ts` | 永続化 |
| `service.ts` | 組み立て → 重複判定 → 送信 → 記録 |

### 経路

- `lib/inquiry/autoReply.ts` — 受信 → 解析 → 返信案 → 通知
- `app/api/line/notify-webhook/route.ts` — follow で通知先を自動登録
- `lib/messaging/mercari/notificationMailParser.ts` / `mailIngest.ts` — メルカリメール
- `lib/messaging/email/gmailClient.ts` / `gmailSecretStore.ts` — Gmail読み取り

### 画面(`メッセージ`)

タブ: 問い合わせ / LINE Bot / メール取込 / 返信ルール / ナレッジ / AI処理ログ

---

## 3. 設計上の判断(なぜそうしたか)

### 顧客向けLINE送信ロックを緩めていない

`lib/messaging/line/outboundGuard.ts` は「BELLO → 実顧客」を既定で止めている
(2026-09-02 指示書 §K)。社内通知Botは**宛先も用途も別**なので、Secret・送信関数ごと
分けた。1つの関数にまとめると、社内通知を通すために顧客向けロックを緩めることになり、
ロックの意味が消える。

社内通知側の誤送信は別の方法で防いでいる:

1. 送信先は follow イベントで登録された userId のみ(手入力の口が無い)
2. その Bot を友だち追加した人にしか送れない(LINEの仕様)
3. `LINE_NOTIFY_DISABLED=true` で全停止できる

### 通知先ユーザーIDを手入力させない

LINEのユーザーIDは人が読んで意味の分かる値ではない。転記を間違えても
**送信APIがエラーを返さないことがある** — 通知は「成功」したまま誰にも届かず、
一番気づきにくい壊れ方になる。実際に友だち追加したイベントからしか登録しない。

### 2通を1リクエストで送る

LINEのpush APIは messages を最大5件まで受け取る。2回のHTTPに分けると、
1通目だけ成功して2通目が失敗する状態が起きうる — 担当者が問い合わせ内容だけ見て
返信案を待ち続けることになる。

### Webhookの中で同期処理している(正直に)

本来はキュー + ワーカーへ逃がすのが筋。Next.js 14.2 には `after()` が無く、
レスポンス後に処理を続ける安全な口が無い。awaitせずに投げると Amplify Hosting
(Lambda)の凍結で処理が消え、**通知したつもりで誰にも届いていない**状態になる。

現状は保存を全部終えてから解析へ入る。LINEがタイムアウトして再送しても、
メッセージ側は `externalMessageId`、通知側は `dedupeKey` で重複しないので、
代償は「無駄な再送が起きうる」だけでデータは壊れない。
将来ワーカーへ移すときは `processInquiryAndNotify` をそのまま呼べばよい。

### 商品特定用テキストを顧客本文と分けた

メールでは商品名・URLが顧客の文面ではなくメタ情報として届く。本文へ混ぜると、
AIが「顧客がURLを送ってきた」と読み、返信文に事実でない前置きを書く。
`InquiryReplyRequest.productLookupText` は商品特定にだけ使い、プロンプトへ渡らない。

---

## 4. 検証

純粋関数へ切り出して全分岐を固定した。通知の不具合は本番でしか見つからないものが
多く(金額の推測・【要確認】の欠落・重複通知・再試行が止まらない)、
「送ってみないと分からない」状態にしないため。

| スイート | 件数 |
|---|---|
| `verify:line-notify` | 70 |
| `verify:reply-rules` | 32 |
| `verify:mercari-mail` | 36 |
| `verify:inquiry` | 230 |
| `verify:negotiation` / `negotiation-case` | 124 |
| `verify:messaging` | 63 |
| `verify:shipping` | 171 |
| `verify:line` | 46 |
| `verify:product-identification` | 60 |
| **合計** | **832件 / 失敗0** |

`tsc --noEmit` / `next lint` / `next build` / `synth:check` すべて成功。

### 実機で確認したこと(Staging / apiId `j6up24p7lnczdmklzjdt3vrp4y`)

Amplifyのデプロイ(job 177)が SUCCEED し、新モデルが実際に作られたことを確認した。

```
LineNotifySettings-j6up24p7lnczdmklzjdt3vrp4y-NONE     作成済み
NotificationDelivery-j6up24p7lnczdmklzjdt3vrp4y-NONE   作成済み / GSI 3本すべて ACTIVE
  notificationDeliveriesByDedupeKey / ByStatus / ByConversationId
ReplyRule-j6up24p7lnczdmklzjdt3vrp4y-NONE              作成済み
```

実データでのラウンドトリップ(一時行を作って消す):

```
✓ NotificationDelivery への書き込み
✓ dedupeKey のGSIで引ける（重複判定が実際に使う経路）
✓ 重複判定が「送信済みなので送らない」と答える
✓ Conversation に channel=BASE を保存して読み戻せる（enum追加が反映済み）
✓ 一時行の片付け完了
```

BASE商品URL → 在庫特定 → 通知文面 までを実在の商品で通し、
指示書§40 Case A(値下げ+配送先あり)/ Case B(値下げ+配送先なし)の
両方で期待どおりの1通目・2通目が生成されることを確認した。
Case B では `【BASE / 要確認】` が付き、理由に「配送先が不明です」が入り、
2通目が「お届け先の都道府県をお教えいただけますでしょうか」になる。

### 検証で見つけて直した実バグ

1. `htmlToText` がタグごと `href` を捨てており、商品URLがリンクの中にしか
   無いメール(通知メールでは一般的)で商品IDを取り落としていた。
2. 1通目の空行が §7-1 のテンプレートと2箇所ずれていた(見出し直後に空行が2つ、
   お名前と本文の間の空行が消えていた)。実データで通して気づいた。
3. LINEの再送を「重複」として素通ししていたため、初回で保存後に解析・通知が
   落ちると**通知が永久に作られない**穴があった。再送をやり直しの機会として
   使うようにした。

---

## 5. 未完了・残課題

| 項目 | 状態 | 理由 |
|---|---|---|
| 実機でのLINE 2通送信 | **未検証** | Botのトークン登録が本人操作(上記A) |
| メルカリメール取り込みの実機検証 | **未検証** | Gmail OAuthが本人操作(上記B) |
| メールパーサの実物合わせ | **未検証** | サンプルメールが必要(上記D) |
| `bello/gmail-oauth` のIAM | **未付与** | 権限操作がブロックされた(上記C) |
| 通知の非同期化(ワーカー) | 未着手 | Next.js 14 の制約。上記「同期処理」参照 |
| Gmail Push(Pub/Sub) | 未着手 | §13-2 は初期実装をポーリングで可としている |
| BASE経路の問い合わせ受信 | 部分 | BASEに問い合わせWebhookが無い。商品特定・通知の口は実装済みで、受信経路が繋がれば動く |
| Yahoo!オークション | 未着手 | 今回の対象外 |
