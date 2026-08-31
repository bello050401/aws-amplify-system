# LINE受信・AI文章生成・Mercari接続 — Staging実機確認（2026-08-31〜09-01）

対象環境: Staging Amplify App `d4hkkg7dty2du` / ブランチ
`claude/inventory-management-system-5vbvc7` / us-west-2 /
AppSync `j6up24p7lnczdmklzjdt3vrp4y`。

前セッションがPowerShellの終了で中断した作業の継続。中断時点の未コミット変更
（`webhookStore.ts` / `novaProvider.ts` ほか）は破棄していない — すべてコミット
`20e325d` 以降に取り込まれている。

---

## 0. 同時実行していた別セッションについて（記録）

作業開始時、中断したはずのセッションが**実際には生存しており**、同じ作業ツリーで
並行して動いていた。そのため本セッションの未コミット編集が、相手のコミット
`f1078bf` へ巻き込まれてpushされている（内容の欠落は無い）。利用者の判断で
そちらを停止し、以降は本セッションのみが作業した。

同一リポジトリで2つのエージェントを同時に走らせると、コミットの混線や
作業の相互破壊が起きうる。次回以降は一方を停止してから始めること。

---

## 1. LINE受信 — 根本原因は「環境変数がSSRランタイムへ届いていない」

### 症状の切り分け（推測ではなく実測）

Stagingへ**正しい署名付きの本物のwebhookリクエスト**を送って切り分けた。

| 手順 | 結果 |
|---|---|
| 不正な署名 | `401 Invalid signature` |
| 正しい署名 | `500 {"ok":false,"failed":1,"reasons":["TABLE_NOT_CONFIGURED"]}` |

署名検証は通っており、その先の**保存だけ**が失敗していた。
`reasons` は `f1078bf` で追加した種別コード（ARN・ロール名・テーブル名・本文は
一切含まない）。これが無ければ「権限が無い」のか「テーブル名が無い」のかを
区別できず、切り分けにさらにデプロイを重ねることになっていた。

### 原因

**Amplifyコンソールに設定した環境変数はビルドには渡るが、Next.jsのSSR
ランタイムの `process.env` には現れない。**

`CONVERSATION_TABLE_NAME` / `MESSAGE_TABLE_NAME` はApp単位の環境変数として
設定済みで、IAM（`BelloAmplifyStagingComputeRole` の
`BelloLineWebhookDataAccess`）もテーブル名も正しかった。にもかかわらず
実行時には両方とも空だった。

### 直し方と、その選び方

`next.config.mjs` の `env` でビルド時にサーバーバンドルへ埋め込む。

`.env.production` へ書き出す方法は**採らなかった** — `amplify.yml` の
`artifacts.baseDirectory` が `.next` なので、リポジトリ直下へ書いたファイルが
実行環境まで運ばれる保証が無い。`env` はwebpackのDefinePluginでビルド時に
リテラルへ置換されるため、`.next` の中だけが配られても値が残る。

**ローカルビルドで実際に確認してから**デプロイした（推測で選んでいない）:

```
CONVERSATION_TABLE_NAME=PROVE-... npm run build
  → .next/server/app/api/line/webhook/route.js  に値が入る
  → .next/static/                                には一切現れない（クライアントへ漏れない）
```

制約: 値がビルド成果物へ焼き込まれるので、Amplify側の環境変数を変えたら
再ビルドが要る。テーブル名は秘密情報ではないので問題ない。
**TOKEN類はここへ書かない** — 従来どおりSecrets Managerから実行時に取得する。

### Staging実機E2E（job 106 デプロイ後、REAL）

```
1) 不正な署名          : HTTP 401  Invalid signature
2) 正しい署名（初回）   : HTTP 200  {"ok":true}
3) 正しい署名（再送）   : HTTP 200  {"ok":true}
```

DynamoDB実測:

| 確認項目 | 実測値 |
|---|---|
| 同一 `externalMessageId` のMessage件数 | **1件**（2回配送したが重複していない） |
| Conversation | `WAITING_FOR_REPLY` / `needsReply=true` / `unreadCount=1` / `priority=NORMAL` |
| 日本語本文 | `【E2Eテスト …】ソファの在庫はありますか` — 文字化けなし |
| `createdBy` | `LINE受信` |

同じ顧客から**2通目**を送り、既存会話へ足す経路（UpdateCommand）も実機で確認:

| 確認項目 | 実測値 |
|---|---|
| `unreadCount` | 1 → **2** |
| `lastMessagePreview` / `lastIncomingAt` | 2通目の内容・時刻へ更新 |
| この会話のMessage件数 | **2件**（会話は増えていない = 新規会話を作っていない） |

E2Eで作成した会話 `09118a7c-fc60-4ade-a0a3-756a06d8df0f` は、メッセージ画面での
表示確認に使えるようStagingへ残してある。不要なら削除してよい。

### 残っている本人操作

LINE Developers Console で Webhook URL を登録すること。

```
https://claude-inventory-management-system-5vbvc7.d4hkkg7dty2du.amplifyapp.com/api/line/webhook
```

Channel Secret は設定済み（上記401/200の結果が、実際に設定された秘密で署名検証が
動いていることの証拠）。

---

## 2. AI文章生成 — 既定をAmazon Novaへ

### 背景

`bedrockProvider.ts` はAnthropic SDKを使い、`modelRegistry.ts` の既定モデルは
3階層とも `us.anthropic.*`。このアカウントでAnthropicモデルを呼ぶとモデルを問わず
`Model use case details have not been submitted for this account.` になり、
利用者本人がAWSコンソールで利用目的フォームを提出するまで**AI文章生成は一切
動かない**。既定を、申請不要で今すぐ動く Amazon Nova へ変更した
（`AI_GATEWAY_PROVIDER=bedrock` で申請後にAnthropicへ戻せる）。

### Staging実行ロールの権限（実測）

推論プロファイル `us.` はプロファイルARNだけでは足りず、ルーティング先の
基盤モデルARNも要る。`get-inference-profile` の実測値と、実行ロールの権限を
突き合わせた。

`us.amazon.nova-pro-v1:0` / `us.amazon.nova-lite-v1:0` のルーティング先は
いずれも us-east-1 / us-east-2 / us-west-2 の3本。

`iam simulate-principal-policy`（`BelloAmplifyStagingComputeRole`）:

| リソース | `bedrock:InvokeModel` | `bedrock:Converse` |
|---|---|---|
| inference-profile（pro / lite） | allowed | allowed |
| foundation-model us-east-1 / us-east-2 / us-west-2 | allowed | allowed |

`NovaGatewayProvider` は `ConverseCommand` を使うため `bedrock:Converse` まで
確認した。

### 実モデル呼び出し（`npm run verify:ai-live`、REAL MODEL VERIFIED）

画面が呼ぶ関数そのもの（`generateListingCopy` / `generateReplyDraft`）を実行。

```
resolveProviderId() => nova
generateListingCopy  2,776ms  title/description/conditionText/sellingPoints 4件
generateReplyDraft   1,134ms  119文字
```

返信案は送料未確定の入力に対し金額を作り出さず「送料を確認のうえ」と書いた —
`lib/ai/ecCopy.ts` の品質ゲート（`/送料[はが]?\s*¥?\d[\d,]*円/` を禁止）が実際に
効いていることの確認。

### 正直な分類

実行ロールが呼べること・実モデルが応答することは実測済み。
**画面の「AIで下書きを生成」ボタンを押しての確認は未実施** — Staging UIの操作は
ADMINログインを要し、認証は利用者本人の操作だから（過去ラウンドと同じ方針）。

---

## 3. Mercari Shops API — 「接続失敗」ではなく「未接続」だった

`npm run verify:mercari-live` を追加して実際に確認した結果、これまでの前提が
1つ間違っていた。

```
TOKENの取得経路      : unconfigured
APIクライアント名     : 未設定
環境                 : sandbox
エンドポイント        : https://api.mercari-shops-sandbox.com/v1/graphql
```

Secrets Manager の `bello/mercari-access-token` は中身が `{"configured": false}`
のみで、**Personal API Access Token は一度も設定されていない**。
アプリは未設定を正しく検出しており、Mercari APIを**呼んでいない**。

つまり現時点のMercariは「404で失敗している」のではなく「まだ接続していない」。
`docs/mercari-404-root-cause-20260830.md` / `docs/zaico-pagination-and-mercari-404-20260831.md`
が扱った404は、TOKENを付けずに直接叩いた実測であり、上記と矛盾しない。

### 残っている作業（いずれもコードでは代替できない）

1. **TOKEN と APIクライアント名の入力**（本人操作）— 設定画面のEC出品タブから。
   値をチャットへ貼る必要はない。
2. 入力後に `npm run verify:mercari-live` で実接続を確認する。ここで404が出た
   場合に初めて、下記のIP登録の問題が現実のものになる。
3. **固定送信元IPの確保**（VPC + NAT Gateway + Elastic IP）— **継続課金が発生する
   ため未実施**。承認前提。
4. **MercariへのIP登録**（契約担当窓口経由、sandbox/production別）。

BELLOはAmplify HostingのSSRコンピュート上で動き、**固定の送信元IPを持たない**。
`verify:mercari-live` が表示する送信元IPは、実行した端末のIP（ローカル実行時は
開発端末）であって、Stagingの送信元ではない。

---

## 4. テスト

| スイート | 件数 |
|---|---|
| verify:messaging | 14 → **44**（webhookStoreのテスト30件を追加） |
| 全15スイート合計 | **818件 green** |
| typecheck / lint | green |

`webhookStore.ts` は実装だけでテストが無かったため、依存（DynamoDB送信・UUID・
時刻）を引数で受け取る継ぎ目 `recordIncomingWebhookMessageWith` を作り、偽の
`send` へ**実際に渡されるコマンド**を検査するテストを追加した。「例外が出ない」
だけを見るテストにすると、違うテーブルや違う式を送っていても気づけないため。

- 新規顧客: 重複判定 → 会話検索 → 会話作成 → メッセージ作成 の順序、
  `WAITING_FOR_REPLY` / `needsReply=true` / `unreadCount=1`、
  `lastIncomingAt` はLINE側の送信時刻（受信を処理した時刻ではない）
- 既存会話: Putで上書きせずUpdate（担当者・優先度など他の項目を消さない）、
  未読+1、`status` は予約語なので `#s` 別名、
  人が `RESOLVED` にした会話は受信だけで差し戻さない
- 再送: 取り込み済みIDは `deduped` を返し、以降一切書き込まない

実接続の確認手段も追加した（`verify:*` は純粋ロジックしか見ないため）:

- `npm run verify:ai-live` — 実際にBedrockを呼ぶ
- `npm run verify:mercari-live` — 実際にMercariへ繋ぐ、送信元IPも表示

AI文章生成が用途申請エラーで完全に死んでいた間も `verify:ai-gateway` は全green
だった。「テストが緑」と「機能が動く」の乖離を埋めるための追加。
