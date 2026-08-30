# 夜間 自動QA・自己修復 記録 (2026-08-31)

対象: Staging (Amplify App `d4hkkg7dty2du`) / branch
`claude/inventory-management-system-5vbvc7` / AWS Account 203918843421 /
us-west-2。

Production App `d1uy61lbnqm8ae` と `main` には一切変更を加えていない
(全commitで `amplify/` の差分が無いことを確認し、Production側branchの
buildは `bello/mercari-access-token` の AlreadyExists で失敗し続けている
状態を維持している)。

---

## 1. 修正した実バグ

### P0-A: 画像自動加工が「0/2」のまま予約できない — **AWS_VERIFIED**

利用者報告:「2件の画像はoriginalHash未計算のため加工を予約できません
でした（詳細画面で画像を保存し直すと自己修復されます）」。

**根本原因**: `originalHash`(画像バイト列のSHA-256)はZAICO同期の2経路の
うち Lambda 側 (`lambdaSyncPort.ts`) だけが計算しており、それ以前の
ブラウザ駆動同期は計算していなかった。実測: 画像1,009枚中**146枚**に
hashが無く、**138商品**が全画像hash無し。

**修正**: `ensureOriginalHash` を全予約経路(単体再加工/商品単位の
「画像を自動加工」/一覧の一括)の手前に置き、hashが無ければサーバー側で
元画像を取得して計算・保存し、そのまま予約を続行する。計算済みは再計算
しない(1画像につき最初の一度だけ)。

**実機検証**: 商品 B000004(hash無し画像5枚、うちNORMAL 3枚)で
「画像を自動加工」を押下 →

| 時刻(UTC) | ProcessingJob | ImageProcessingVersion |
|---|---|---|
| 15:16:42 | PENDING ×3 | 0 |
| 15:20:30 | PENDING ×3 | 0 |
| 15:21:33 | **DONE ×3** | **3** |

同時に NORMAL 画像3枚の `originalHash` が「なし → あり」へ。
UI → Server Action → hash自己修復 → DB → queue → worker → 加工 →
version生成 まで一気通貫で成立。旧文言「保存し直す」「originalHash」は
画面から消えた。

### P0-B: Photo Profile 作成が Server Components エラー — **LOCAL_VERIFIED**

**根本原因**: `PhotoProfile.referenceImageKeys` 等は `a.json()` =
AWSJSON で、**JSONエンコード済み文字列しか受け付けない**。生の配列を
渡していた。stagingのAppSyncへADMINトークンで両方の形を実際に投げて確定:

| 渡し方 | 結果 |
|---|---|
| 生の配列 | `Variable 'referenceImageKeys' has an invalid value.` |
| JSON文字列 | 作成成功 |

同じ罠は `Feature.content` で一度踏んでいる(commit 4bd0a1b)。三度目を
防ぐため変換を `lib/imageProcessing/photoProfile.ts` の1箇所へ集約した。

副次的に、失敗時にGraphQLのエラーオブジェクトをそのままUIへ出していた
のを止め、旧ACTIVEの降格失敗が作成全体を巻き添えにしないようにした。

### P0-C: AI生成が `ANTHROPIC_API_KEY` 必須で停止 — **LOCAL_VERIFIED** / 実行は **BLOCKED_BY_EXTERNAL_SERVICE**

`getProvider()` が無条件にAnthropic直APIを返しており、キーが無い環境では
商品説明生成が必ず失敗していた。BedrockGatewayProvider を追加し、
明示指定 > キーの有無、で解決するようにした(キーがあれば従来どおり)。

**外部ブロッカー(実測)**: このAWSアカウントではBedrockの`Converse`が
モデルを問わず拒否される。

```
AccessDeniedException: Your account is currently being verified.
Verification normally takes less than 2 hours.
```

モデルアクセス許諾ではなく**AWS側のアカウント検証待ち**。検証完了後は
そのまま動作する。Staging の SSR ロールには `BelloBedrockInvoke` を
付与済み(Production ロールには触れていない)。

### QA-a: LINE webhook が取りこぼしを隠していた — **LOCAL_VERIFIED**

`recordIncomingMessage` が失敗しても常に 200 `{ok:true}` を返していた。
LINEは2xxを受信成功とみなして**再送しない**ため、記録に失敗した
メッセージはそのまま失われる。当時のコメントが前提にしていた
「失敗してもLINEの再送で安全に再処理できる」は、200を返している限り
成立していなかった。

1件でも失敗したら500を返して再送させるよう変更。再送で重複しないことは
`externalMessageId` のGSIによるidempotencyが保証する。

### QA-b: 設定ページが87.5%失敗 — **自分の退行** — 修正済み

料金マスターを2件→450件にした直後、設定ページを8回開いたところ**7回が
HTTP 500**。他ページは正常だったため切り分けられた。

**原因2つ**:

1. 設定ページがADMINの描画ごとに `dedupeMasterEntries`×2 と seed 3種を
   直接実行していた。2件のうちは実質no-opだったが、450件になった時点で
   1回の描画中に400件超の**逐次書き込み**を試みるようになり、描画時間内に
   終わらず500。テーブルは中途半端に埋まり続けた(134件 → 411件)。
2. `seedShippingRates` の重複判定が `destinationArea` を見ておらず、
   createもareaを書いていなかった。全国表では**北海道4エリアが1件に
   潰れる**。実測: staging の411件すべてが `destinationArea: null`。

**修正**: 重複判定キーにエリアを含め、createでも書く。既存行の走査は
ページングする。ブートストラップは `ensureSettingsBootstrap` で
プロセス単位に畳み、1回あたりの書き込みを60件に制限(冪等なので次の
アクセスで続きが入る)。失敗はキャッシュせず、例外でページを落とさない。

壊れた411行は削除して作り直した(全行 `createdBy: "system-seed"`、
手動投入行は0件であることをスクリプトが確認したうえで実行)。

**修正後の実測(AWS_VERIFIED)**:

| 状態 | 設定ページ成功率 | 応答時間 |
|---|---|---|
| 修正前 | 8回中1回(87.5%失敗) | 平均 3,159ms |
| 修正後・投入中 | 6回中5回 | 5〜7秒(60件ずつ投入) |
| **修正後・投入完了** | **10回中10回(失敗0)** | **中央値 1,035ms** |

料金マスターは **450/450件** で完了。北海道は **36行(4エリア×9ランク)**
で、**全行が `destinationArea` を保持**(修正前は0行)。エリアは
函館 / 札幌·千歳 / 道北 / 道東 の4種すべてが存在する。

### QA-c: Bedrockのエラー本文がUIへ露出していた — **LOCAL_VERIFIED**

「AIで下書きを生成」を実機で押したところ、`ANTHROPIC_API_KEY` の文言は
消えて実際にBedrockへ到達するようになった一方、403の**上流メッセージが
そのまま画面に出ていた**:

```
403 {"type":"error","request_id":"req_...","error":{"type":
"permission_error","message":"User: arn:aws:sts::<account>:assumed-role/
<RoleName>/AmplifyHostingCompute-app=<appId> is not authorized to
perform: bedrock-mantle:CreateInference ..."}}
```

アカウントID・実行ロール名・アプリID・拒否アクション名・request_idが
利用者向け画面に出ていた。`describeBedrockError` が上流本文を混ぜない
ようにし、status/エラー型で分類した日本語だけを返すよう修正。

**同時に判明した権限の誤り**: `AnthropicBedrockMantle` クライアントは
`bedrock:InvokeModel` を呼ばない。実際に必要なのは

```
bedrock-mantle:CreateInference on
arn:aws:bedrock-mantle:<region>:<account>:project/default
```

最初に付与したのは `bedrock:*` だったため効かず、
`simulate-principal-policy` が「allowed」と答えたのも**実行時に使われ
ないアクションをsimulateしていた**ため。Stagingロールへ
`bedrock-mantle:CreateInference` を追加した(Productionロールは未変更)。

**あわせて BLOCKED_BY_EXTERNAL_SERVICE が1件解消**: Bedrockの
アカウント検証が完了し、管理者資格情報でのConverse呼び出しが成功する
ようになった。

---

## 2. 誤検知として退けたもの(報告しなかった)

実測で否定できたものを、次の担当者が再度追いかけないよう記録する。

| 疑い | 実測による否定 |
|---|---|
| 「139件が一覧から消えている」 | 既定の一覧経路は `listInventory` 系で、カーソルGSIは未接続。全件表示されていた |
| 「24件で `listUpdatedAt` がずれている」 | アプリ打刻とAppSync打刻の数十〜200msの差。並び順に影響しない |
| 「EC出品一覧が0件でバグ」 | 全1,000件が除外カテゴリ(発送完了985/破棄14/補修待ち1)。**0件が正しい** |
| 「Server Actionに認可が無い」 | data層が `authMode: userPool` + グループ認可で拒否する。未認証では到達不能 |
| 「adminMemoがVIEWERに見えるのは漏洩」 | 仕様§133「認証済みBELLO内部userのみ」。VIEWERは内部user、適合 |
| 「押しても何も起きないボタン」 | 静的スキャンが多行JSXを扱えず誤検知。該当ボタンには次行に `onClick` |
| 「`draftReply` がerrorsを未検査」 | `if (errors || !data)` の形で検査済み。grepパターンの誤り |
| 「未使用のlibエクスポート13件」 | 定義ファイル内でのみ使う内部ヘルパー |

### 自分の判断ミス2件

**「間欠500はデプロイ時のコンテナ入替が原因」と2回結論したが、2回とも
再デプロイ直後に測っていた。** 8ラウンド走らせたら設定ページの実バグが
残っており、しかもそれは自分の退行だった。以降は**デプロイ完了後10分
待ってから測る**運用に変えた。

---

## 3. 実測した状態(証拠)

### ZAICO — 退行なし

| 指標 | 値 |
|---|---|
| Inventory | 1,000 |
| distinct ZAICO ID | 1,000 |
| **重複グループ** | **0** |
| ZaicoSourceLink | 1,000(全ID) |
| 最終同期 | `created 0 / updated 0 / unchanged 1000` |

### CSV/XLSX インポート — 実ファイルで検証

| 検証 | 結果 |
|---|---|
| 実CSV(BELLOエクスポート、UTF-8 BOM付き) | 53列 / 9行、BOM除去済み |
| 実XLSX(ZAICOエクスポート) | 47列 / 144行 |
| 壊れたXLSX / 0バイト | 例外あり・日本語で対処可能な文言 |
| 空CSV / ヘッダーのみ | 例外なく空配列 |

### 性能ベースライン

Lambda実行時間(直近1時間):

| Worker | 実行 | 中央値 | 最長 | timeout |
|---|---|---|---|---|
| zaico-sync-worker | 26 | 51ms | 792ms | 240s |
| image-processing-worker | 25 | 41ms | 2,952ms | 300s |
| pricing-scheduler | 3 | 309ms | 512ms | 60s |

DynamoDB 読み取りコスト(1,000件時点):

| 経路 | 消費RCU | 走査行数 |
|---|---|---|
| 一覧の全件走査(現行の既定) | **129.0** | 1,000 |
| カーソルGSI(50件) | **8.0** | 50 |

1ページ表示あたり約16倍。在庫が増えるほど全件走査は線形に悪化し、GSIは
一定。`listingPartition` のバックフィルは完了済み(1,000/1,000)なので、
カーソル経路を既定にする残条件は「総件数を返さない」「"前へ"が1段分」の
2点のみ。

---

## 4. ブロッカー

### BLOCKED_BY_EXTERNAL_SERVICE

**Mercari Shops API 404** — 原因を実測で確定。未登録IPからダミートークンで
両エンドポイントへ実リクエストした結果、**トークン検証より前に404**が返る:

```
api.mercari-shops.com/v1/graphql          HTTP 404 "Not Found" (0.12s)
api.mercari-shops-sandbox.com/v1/graphql  HTTP 404 "Not Found" (0.24s)
```

公式APIリファレンスのFAQ(直接取得できた。以前は EGRESS_BLOCKED で
読めず推論に頼っていた)の記載と一致する:

> APIにアクセスすると 404 NotFound エラーが返却されました
> → 申請いただいていないIPアドレスからのリクエストに対しては
>   404 NotFound が返却されます。

同FAQが課す条件:
- **日本国内の固定IPアドレス**であること
- **他社と共有しているIPアドレスは使用不可**
- **範囲(CIDR)指定は不可、個別のホストアドレスで申請**
- 許可IPはSandbox/本番で別管理

なお docs にある「Static outbound IP addresses」は **Webhookセクション
配下 = Mercari→自社への送信元IP**であり、API client の allowlist とは
別物(仕様書§28が混同を警告していた点の正体)。

**アーキテクチャ上の帰結**: Staging は us-west-2(オレゴン)。そこに
NAT Gateway + EIP を置いても**米国のIP**になり「日本国内の固定IP」要件を
満たさない。固定IPを取るなら ap-northeast-1(東京)側へegressを寄せる
設計が必要。実測前に作らない(仕様書§28「必要性が確認できないのに
NAT Gatewayを作らない」)。

**Amazon Bedrock** — アカウント検証待ち(上記P0-C)。

### BLOCKED_BY_USER

| 対象 | 必要な操作 | 完了後に再開する検証 |
|---|---|---|
| Mercari 実接続 | 設定画面でPersonal API Access TokenとAPIクライアント名を保存 | 実404の再現とエラー分類の確認。ただし上記IP要件が未達の間は404のまま |
| Mercari IP登録 | Mercari契約担当経由で**日本国内の固定IP**を申請(Sandbox/本番それぞれ) | 実接続成功の確認 |
| LINE 実連携 | Channel Secret / Access Token を保存し、Webhook URL をLINE Developers Consoleへ登録 | 受信→Conversation/Message生成の実確認 |
| Bedrock | AWSアカウント検証の完了(AWS側の手続き) | AI下書きの実生成 |

### QA-c 続報: Mantle経路は行き止まりだった — **BLOCKED_BY_USER**

`bedrock-mantle:CreateInference` を付与して403は消えたが、次は
`404 The model '...' does not exist` になった。ここで「モデルIDが違う」
と決めつけず、Mantleのエンドポイントへ総当たりした:

| 渡したモデルID | 結果 |
|---|---|
| `claude-haiku-4-5` / `claude-sonnet-4-5` / `claude-sonnet-4-6` | 404 does not exist |
| `claude-opus-5` / `claude-sonnet-5` | 404 does not exist |
| `claude-haiku-4-5-20251001` など日付入り | 404 does not exist |
| `us.anthropic.claude-haiku-4-5-...-v1:0` | 404 does not exist |
| `GET /v1/models` | 404 |

**このアカウントのMantleプロジェクトにはモデルが1件も存在しない。**
一方、通常のBedrock側には`us.anthropic.*`の推論プロファイルが21件実在
したため、`AnthropicBedrockMantle` → `AnthropicBedrock` へ切り替えた。

通常Bedrockでの実測(us-west-2、1件ずつ`messages.create`):

| モデル | 結果 |
|---|---|
| `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | **生成成功** |
| `us.anthropic.claude-sonnet-4-6` | **生成成功** |
| `us.anthropic.claude-opus-4-5-20251101-v1:0` | **生成成功** |
| `us.anthropic.claude-sonnet-5` / `opus-5` / `fable-5` | 403 not available for this account |
| `us.anthropic.claude-3-haiku` / `claude-3-sonnet` | 404 marked by provider as Legacy |
| `us.anthropic.claude-haiku-4-5-...` | 404 用途フォーム未提出 |

**ただしこの3件の成功は初回のみだった。** 直後から同じ呼び出しが一貫して

```
404 Model use case details have not been submitted for this account.
    Fill out the Anthropic use case details form before using the model.
```

を返すようになり、5連続で再現した。**1回成功しただけで「解決」と
しない**という原則がそのまま当てはまったケースで、成功した3件を根拠に
「AI生成は動く」と報告していたら誤報になっていた。

根本原因はAWSの一次APIで確定させた(推測ではない):

```
aws bedrock get-use-case-for-model-access
-> ResourceNotFoundException: You have not filled out the request form.
```

**これはコードでは解消できず、AWSコンソール(Bedrock → モデルアクセス)
での用途フォーム提出という利用者側の操作が必要**。したがってAI生成は
**BLOCKED_BY_USER**であり、LOCAL/コード側は完成している。

対応した内容:

- Provider を `AnthropicBedrock` へ変更(Mantleは廃止)
- Registryを**実際に生成が返ったモデルだけ**に差し替え
  (ECONOMY=Sonnet 4.5 / STANDARD=Sonnet 4.6 / PREMIUM=Opus 4.5)。
  存在しないIDを登録するとescalation時に必ず落ちるため
- `thinking: {type:"adaptive"}` はClaude 4.6以降のみ送る
  (4.5系へ送ると400)。Registryの`supportsAdaptiveThinking`で出し分け
- 用途フォーム未提出の404を「モデルIDが違う」ではなく
  **「AWSコンソールで利用申請を提出してください」**と案内する分類を追加
- IAMから`bedrock-mantle:CreateInference`を削除(最小権限)。
  手順は `scripts/aws-setup/11-apply-staging-bedrock-policy.ps1` に固定
  — Stagingロール以外を対象にしたら実行を拒否する

### QA-1: Photo Profile を実機で作成 — **AWS_VERIFIED**

| 操作 | 結果 |
|---|---|
| 基準写真3枚をS3へアップロード | 成功(3.5秒) |
| 「作成してACTIVEにする」 | **v1 / 3枚 / ACTIVE** |
| 画面エラー・Consoleエラー・HTTP 4xx/5xx | **いずれも0件** |
| リロード後の保持 | 保持される |
| 2本目を作成 | **v2がACTIVE、v1が自動的に「履歴」へ** |
| v1を手動で「ACTIVEにする」 | v1がACTIVE、v2が履歴へ戻る |

P0-Bで直したServer Componentsのレンダーエラーは再現しない。
なお`photoProfile`はworkerで**version記録にのみ**使われ、加工結果には
影響しない(セグメンテーション未実装のため意図的)ので、この検証用
Profileが実データの加工を歪めることはない。

---

## 自動QAフェーズ 第2ラウンド

### QA-d: hydration が壊れていた2箇所 — **AWS_VERIFIED**

Staging実機のConsoleに `Minified React error #418 / #425` が出ていた。
本番ビルドでは番号しか出ないため、ローカルの開発ビルドで同じ操作を
再現して全文を取得した。

**(1) 売上ページ — SVGの`<title>`**

```
Warning: Expected server HTML to contain a matching text node for "2025" in <title>
  at SalesTrendChart
Hydration failed because the initial UI does not match what was rendered on the server.
```

`<title>`の中に式を6つ並べていた。ReactはSSR時に隣り合うtextノードの
間へ `<!-- -->` を挟むが、`<title>`はHTMLのRCDATA要素でコメントが
解釈されず生の文字列になるため、hydrationがtextノードを対応付けられず
失敗する。テンプレートリテラル1つにまとめて解消。同じ形が
`PricingRuleAssignForm`の`<option>`にもあったため併せて修正。

**(2) 在庫一覧 — タイムゾーン依存の日付**

```
Warning: Text content did not match.
  Server: "2026/8/31"  Client: "2026/8/30"
```

`new Date(iso).toLocaleDateString("ja-JP")` は**実行環境の**タイムゾーンで
日付を出す。Amplify HostingのSSRはUTC、ブラウザはJSTなので、UTC 15:00
以降に更新されたレコードが一覧に出ていると必ずずれる。

「今日/今月」の判定をJSTで行う既存方針(`nowInJst`)に合わせ、
`lib/inventory/formatJst.ts` を追加して**表示もJST固定**にした。
日付を出していた6箇所すべてを移行。

検証(ローカル開発ビルド、3ページ × 3タイムゾーン × 3回 = 27回):

| | 修正前 | 修正後 |
|---|---|---|
| /inventory (Asia/Tokyo) | 2/3で発生 | **0/3** |
| /inventory/sales | 3/3で発生 | **0/3** |
| 27回の合計 | — | **hydrationエラー 0件** |

### QA-e: 画像1枚ごとにCognitoの資格情報を取り直していた — **修正済み**

在庫一覧を1回開くだけで、Cognito Identity Poolへの通信が実測200回超:

```
100 x GetId 200
 99 x GetCredentialsForIdentity 200
  3〜27 x GetCredentialsForIdentity 400 TooManyRequestsException
```

各行のサムネイルが独立したコンポーネントで、mount時に全行が同時に
`getUrl()`を呼ぶ。Amplifyは資格情報をキャッシュするが、**1件目が返る前に
残り全部が走る**ため誰もキャッシュに当たらない。スロットリングされた分は
hook側のリトライで復旧するので画像自体は最終的に表示され、**問題が
見えないまま画像1枚につき2往復を払い続けていた**。

対策: 共有した`fetchAuthSession()`のPromiseを最初に1回だけ待たせ、
その後は署名の同時実行数を6に制限。

| | 修正前 | 修正後 |
|---|---|---|
| GetId | 100回 | **1回** |
| GetCredentialsForIdentity | 91〜99回 | **1回** |
| スロットリング(400) | 3〜27回 | **0回** |

### QA-f: モバイルのタップ領域 — **修正済み**

以前のラウンドで`CustomFieldSettings`と`ListColumnSettings`は32px角へ
広げていたが、**設定画面が最初に開くタブである`MasterList`が漏れていた**。
390pxで実測すると、そのタブだけで24px未満の操作要素が95個
(19行 × チェックボックス13x13 / ↑13x20 / ↓13x20 / 状態ピル51x23 /
削除24x18)。

文字サイズは一切変えず当たり判定だけを広げ、チェックボックスは見た目を
保つためlabelで包んだ。ヘッダーのログアウト(60x16、全ページに出る)、
全選択/選択解除、EC出品一覧の全選択、受信箱のフィルタ4つ、新規登録の
戻るリンクも同様に対応。

| | 修正前 | 修正後 |
|---|---|---|
| 6ページ × 390/430px の小さいタップ領域 | **105件** | **0件** |
| 横スクロール・pageerror | 0 | 0 |

### QA-g: 自動値下げの「下限到達時の動作」が4択とも同じだった — **修正済み**

設定画面は「そのまま維持 / 出品を停止 / 再出品（未実装） / 手動確認を
促す」の4択を出し、未実装と書かれているのは再出品だけ。しかし
`actionAtFloor`は**保存され、フォームに読み戻されるだけで、判定側が
一度も読んでいなかった**。下限に到達すると`AT_FLOOR_PRICE`で止まるだけで、
「出品を停止」を選んでも何も停止しない。

- PAUSE → statusをPAUSEDにする
- MANUAL_REVIEW → automationHoldを立てて確認待ちにする
- KEEP → 従来どおり何もしないが、理由は監査ログへ残す
- RELIST → Mercariの再出品APIが未確認のため引き続き実行せず、
  「何もしなかった」ことを記録に残す

判定は`pricing.ts`の純粋関数`decideActionAtFloor`へ切り出し、
4択が互いに異なる結果になることをテストで固定した(再び同一へ潰れる
退行の検出)。現在`autoPricingEnabled`の出品は0件のため、進行中の
動作は何も変わらない。

### QA-h: エクスポートしたCSVを無編集で取り込むと全行が「更新」になった — **修正済み**

エクスポート → 1文字も変えずにインポート → プレビューが
「スキップ（変更なし）」ではなく**「更新 1件」**。56列を二分探索して
原因列が**「更新日」**であることを特定した。

`exportFields.ts`は以前から「更新日」「作成日」「棚卸日」へ
`importable: false`を付けていたが、**そのフラグがどこからも参照されて
おらず**、書き込み対象へ素通りしていた(除外されていたのは照合キーの
displayId/skuだけ)。表示用に整形された日時は保存値と一致しないので、
毎回「変更あり」と判定されていた。

この画面の通常の使い方は「エクスポート → Excelで一部だけ直す →
取り込む」なので、**触っていない行まで往復のたびに書き換わり、更新履歴が
実際の変更で埋もれる**状態だった。

`isWritableImportTarget()`へ一本化してフラグを効かせ、実機の
インポートウィザードで同じ無編集CSVが**「スキップ（変更なし）1件」**に
なることを確認。追加項目(CustomFieldDefinition由来)は従来どおり
書き込める。

あわせてエクスポートのファイル名も`toISOString()`(UTC)から
JST基準へ変更した — UTCで動くAmplifyでは、日本時間の朝9時より前に
出力すると前日の日付のファイル名になっていた。

### QA-i: 呼び出し元の無いServer Action — **削除**

`app/actions/`配下の全exportを走査し、他ファイルから一度も参照されない
ものを探したところ`getConversationAction`の1件だけだった
(ネットワークから到達できる入口が用途無く1つ増えている状態)。削除。

`relistEnabled`/`relistAfterDays`、画像加工の`highlightRecovery`/
`shadowLift`も未使用だが、いずれも**UIに露出しておらず利用者が設定
できない**休眠スキーマ/型定義であり、実害が無いため触っていない。

### QA-j: 主要業務フローの実機E2E — **AWS_VERIFIED**

| フロー | 結果 |
|---|---|
| 在庫検索(URL同期・リロード保持・戻る) | 1,000件→「ソファ」28件、`?q=ソファ`がURLに乗り、リロード後も保持、戻るで全件へ |
| 危険な入力(`<script>` / `' OR 1=1 --` / `%%%` / 絵文字) | いずれも0件表示・例外0・ダイアログ発生なし |
| 不正URLパラメータ(page=-1/99999/abc, limit=999999, sort=;drop) | すべてHTTP200で既定表示に落ちる |
| 存在しない商品ID | HTTP404 |
| メッセージ | 会話作成→要返信→下書き保存→**確認ダイアログ**→送信済み→解決済み まで完走、エラー0 |
| 新規登録 | 必須未入力は登録不可 / 正しく入力すると作成される |
| EC出品下書き | 保存→リロード後も価格・説明文が永続化→**EC出品一覧に1件表示** |
| 対象外カテゴリでの下書き保存 | 「カテゴリー『発送完了』はEC出品の対象外です。」で正しく拒否 |
| テスト商品の削除 | 確認ダイアログ→削除→直接URLは404、**在庫総数は1,000件に復帰** |

**「EC出品一覧が0件」は不具合ではないことの実証**: 既存1,000件は全て
除外カテゴリ(補修待ち/発送完了/事務所備品/コーディネート用/無償提供/
破棄)に属するため0件が正しい。除外対象でないカテゴリの商品を1件作ると
即座に「1件表示」になり、削除すると戻った。

**売上ページの年の検証漏れ(修正済み)**: 月は1〜12を検証していたのに年は
素通りで、`?y=-5` → 「-5年8月」、`?y=1e10` → 「10000000000年3月」が
そのまま見出しに出ていた。前月/翌月リンクもその値から作られる。月と
同じ形で範囲検証を追加。

### QA-k: 画像加工workerの実動作 — **AWS_VERIFIED**

UIの「画像を自動加工」→ ProcessingJob 4件がPENDING → **1分以内に
worker(5分周期)が処理し全16件がDONE** → ImageProcessingVersionに
master/web/thumbnailの3種が揃った行を生成(16行すべて欠けなし)。

S3の実体も確認: master JPEG 238KB / WebP 63KB / サムネイル 6KB が
正しいContent-Typeと`public, max-age=31536000, immutable`付きで生成され、
**オリジナル画像(37KB)は無傷で保持**されている。Lambdaはメモリ126MB/
1024MBで安定し、sharpのINIT失敗は再発していない。

`NEEDS_REVIEW`のままなのは**仕様どおりの安全側動作**(被写体
セグメンテーション未実装のためcompositionConfidenceが常に0 →
自動採用しない、とpipeline.tsに明記されている)。

### QA-l: 認証境界とセキュリティヘッダー

未ログインの新規ブラウザで直接アクセスした結果:

| 対象 | 結果 |
|---|---|
| /inventory, /sales, /listings, /messages, /settings, /new, /{id}, /{id}/edit | すべて `/inventory/login` へ転送、**在庫データの露出なし** |
| /admin | `/admin/login` へ転送 |
| `Next-Action`ヘッダー付きPOST(Server Action直叩き) | HTTP 307で拒否 |
| 未認証時のHTML内の在庫文字列 | 0件 |

一方、**レスポンスにセキュリティヘッダーが1つも付いていなかった**
(HSTS/X-Frame-Options/X-Content-Type-Options/Referrer-Policy いずれも無し)。
認証済みセッションで在庫・売上・顧客メッセージを扱う画面なので、
clickjacking対策を含む最低限を`next.config.mjs`で付与した。

**Content-Security-Policyは意図的に入れていない** — Cognito・AppSync・
S3署名付きURL・Amplifyのインラインスクリプトへ同時に依存しており、
許可元を実測で洗い出さずに付けると本番で静かに壊れるため。別作業とする。
`Permissions-Policy`でcamera/microphone/geolocation/paymentを拒否する前に、
アプリがそれらのAPIを一切呼んでいないことをコード走査で確認した。

### 検証中に出た「不具合に見えたが違ったもの」(再掲)

- **編集画面が「全4枚」なのにDBは6枚** … NORMAL 4枚とDAMAGE 2枚が別
  セクションに分かれており、保存時に両方を合成する設計。欠落ではない。
- **詳細画面で9枚中1枚しか表示されない** … 待ち時間不足。遅延読み込みが
  終わるまで待つと9枚すべて表示。
- **一覧で101枚中51枚しか表示されない** … 同じく画面外の遅延読み込み。
  スクロールすると101/101。
- **ImageProcessingVersionのmasterKeyが空** … フィールド名は
  `processedMasterKey`。自分の確認スクリプトの見誤り。
- **ローカルで在庫登録が「権限がありません」** … Stagingのcookieを
  localhostへ書き換えて使っているための差異。**実機では正常に作成できる**
  ことを確認済み(作成→EC下書き→削除まで実施)。
- **エクスポートのファイル名が1日ずれている** … 検証マシンの時計の問題で、
  ファイル名は実行環境の日付。ただしUTCで動く実機では朝9時前に前日日付に
  なりうるため、JST基準へ変更した(これは実際の修正)。

### QA-m: 性能実測（Staging、1,000件時点）

各ページ3回ずつ計測した実測値:

| ページ | TTFB | DOMContentLoaded | 総所要(中央値) |
|---|---|---|---|
| **在庫一覧** | **3,253ms** | 3,310ms | 5,387ms |
| 売上 | 1,980ms | 2,028ms | 3,667ms |
| EC出品一覧 | 1,941ms | 2,002ms | 3,558ms |
| 商品詳細 | 990ms | 1,042ms | 2,522ms |
| 設定 | 703ms | 753ms | 2,263ms |
| メッセージ | 512ms | 572ms | 2,086ms |

在庫一覧が突出して重い理由は特定済み: `listInventory`は
**毎回`fetchAllInventoryRecords`で全件を取得し、メモリ上でソート・
スライスしている**。1ページ50件しか表示しないが、1,000件すべてを
200件ずつ5回に分けて取得している。

これは**バグではなく明文化された設計判断**(「一覧に必要な列だけの
軽量レコードを1回で全件取得してメモリでソートするほうが、複合GSIを
足すより実装・運用コストが低い」)で、安全弁
`SEARCH_MAX_SCAN_ITEMS = 20000`と、規模超過時はOpenSearch等へ、という
移行方針もコメントにある。ただし**件数に比例して伸びる**ため、
1,000件で3.2秒という実測値を残しておく。

**今回は書き換えていない**。理由:
- 一覧はトップ画像のサムネイルを出すため`images`配列を必要とし、
  `selectionSet`で列を削る単純な軽量化ができない(サムネイルが消える)。
- cursor方式への移行(`lib/inventory/inventoryCursorList.ts`、設定画面に
  下準備のバックフィルがある)は、総件数表示
  (「1,000件中 1–50件表示」)の扱いを含む挙動変更で、最も使う画面での
  退行リスクが高い。**一晩の自動QAで根拠なく差し替えるべき範囲を超える**。

あわせて、`fetchAllInventoryRecords`の上のコメントが
「listInventoryはcursorページングの安価な経路として無変更で残す」と
**実態と食い違ったまま**だったので、実測値つきで現状に合わせて訂正した。
