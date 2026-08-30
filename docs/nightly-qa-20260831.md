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
