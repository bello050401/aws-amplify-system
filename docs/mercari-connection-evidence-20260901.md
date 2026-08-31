# Mercari Shops 接続: 実測による原因確定と保存デッドロックの解消 (2026-09-01)

夜間統合指示書(2026-09-01) §3 の対応記録。
**推測と実測を分けて書く。** 断定しているものは、この文書内に再現手順と実測結果がある。

---

## 1. 結論(先に)

1. **「TOKENを保存できない」は、設計上のデッドロックだった。** 実装が
   「接続確認に成功した場合のみSecretへ保存」だったのに対し、Mercariは
   **未登録の送信元IPからのリクエストを、認証を評価する前に404で拒否する**。
   したがってIPが未登録である限り、**正しいTOKENを入力しても保存できない**。
   → 保存ポリシーを変更して解消した(§4)。

2. **エンドポイントURLは正しい。** `/v1/graphql` は実在する(§2.2の実測)。
   以前「URLが誤っている可能性」を残していたが、これは否定できた。

3. **User-Agent欠落は404の原因ではなかった。** 正しい形式のUser-Agentを
   付けても応答は1バイトも変わらない(§2.1)。以前の「User-Agent未送信が
   404の有力な根本原因候補」という記述は、実測により **否定** される。
   (User-Agentを送ること自体は公式の必須要件なので、実装は維持する。)

4. **404はIPアドレス制限で説明が付く。** 公式ドキュメント本文に明記があり
   (§3)、実測の挙動とも完全に整合する(§2)。ただし **BELLOのIPがMercari側で
   未登録であることを我々の側から直接確認する手段はない** ため、UIの文言は
   「可能性」として提示する(断定しない)。

5. **新事実: 許可IPは「日本国内の固定IP」で「他社と共有していない」ことが
   要件。** これは以前の想定になかった制約で、**構成案に影響する** —— BELLOの
   Amplify Hostingは `us-west-2`(米国)であり、そこにNAT Gateway + Elastic IP
   を置いても **米国のIPになるため要件を満たさない**。§6を参照。

---

## 2. 実測(2026-09-01、開発端末から)

### 2.1 認証・User-Agentの有無で応答が変わるか

`POST https://api.mercari-shops.com/v1/graphql` および sandbox に対し、
ヘッダの組み合わせを変えて同一のGraphQLクエリを送信した。

| 環境 | Authorization | User-Agent | 応答 |
| --- | --- | --- | --- |
| sandbox | なし | なし | `404` `text/plain` `"Not Found\n"` (server: cloudflare) |
| sandbox | なし | `bello-probe/0.0.0` | `404` `text/plain` `"Not Found\n"` |
| sandbox | `Bearer <無効なダミー>` | `bello-probe/0.0.0` | `404` `text/plain` `"Not Found\n"` |
| production | なし | なし | `404` `text/plain` `"Not Found\n"` |
| production | なし | `bello-probe/0.0.0` | `404` `text/plain` `"Not Found\n"` |
| production | `Bearer <無効なダミー>` | `bello-probe/0.0.0` | `404` `text/plain` `"Not Found\n"` |

**読み取れること:**

- 応答は6通りすべてで完全に同一(本文10バイト)。
- **Authorizationヘッダを一切付けない場合ですら404** ——
  つまり404は **TOKENの内容に依存していない**。
  TOKENが正しくても誤っても、未登録IPからは同じ404になる。
- したがって「TOKENが正しければ接続確認が通る」という前提が成り立たない。
  これが保存デッドロックの直接の原因(§4)。

> 使用したのは構文上ありえるだけの無効なダミー文字列であり、
> 実在のTOKENは一切使用していない。

### 2.2 404はパス誤りではないか(反証候補の検証)

同一ホストの複数パスへ `GET` して、404の**本文**を比較した。

| パス | production | sandbox |
| --- | --- | --- |
| `/` | `404` `"404 page not found\n"` (19B) | `404` `"404 page not found\n"` (19B) |
| `/v1/graphql` | `404` **`"Not Found\n"` (10B)** | `404` **`"Not Found\n"` (10B)** |
| `/docs/index.html` | **`200` `text/html` 1,339,485B** | `404` `"Not Found"` (9B) |
| `/definitely-not-a-real-path-zzz` | `404` `"404 page not found\n"` (19B) | 同左 |
| `/healthz` | `404` `"404 page not found\n"` (19B) | 同左 |

**読み取れること:**

- 存在しないパスは Go の `http.ServeMux` 既定の `"404 page not found\n"` を返す。
- `/v1/graphql` はそれとは **異なる本文** `"Not Found\n"` を返す。
  → **このルートは存在し、専用のハンドラが処理している。**
  「URLが違うから404」という反証候補は否定される。
- production の `/docs/index.html` は **同じ送信元IPから200を返す**。
  → Cloudflareのエッジで全面的にブロックされているわけではない。
    拒否は `/v1/graphql` というAPIルートに限定されている。

### 2.3 再現方法

`npm run verify:mercari-live` が、設定の取得経路・エンドポイント・
このマシンの送信元IP・実リクエストの結果を出力する(秘密値は出さない)。

---

## 3. 公式ドキュメントの記載(一次資料)

**重要な更新: `https://api.mercari-shops.com/docs/index.html` はこの端末から
直接取得できる(HTTP 200、約1.3MB)。** 以前のセッションはこのURLへ到達できず
検索エンジンの要約に頼っていたが、その必要はない。以下は本文からの引用。

### IPアドレス制限

> **Q: APIにアクセスすると 404 NotFound エラーが返却されました**
> 申請いただいていないIPアドレスからのリクエストに対しては 404 NotFound が
> 返却されます。必要に応じてIPアドレスの申請をお願いします。

> **Q: 申請済みのIPアドレスでアクセスしても 404 NotFound エラーが返却されます**
> 許可IPアドレスはSandbox環境と本番環境それぞれで管理されています。
> 使用中のIPアドレスが対象の環境で許可されているかをご確認ください。

> **Q: 申請可能なIPアドレスの要件を教えて下さい**
> **日本国内の固定IPアドレスである必要があります。他社と共有している
> IPアドレスは使用不可となります。**

> **Q: IPアドレスの範囲指定は可能ですか？**
> IPアドレスの範囲指定はできません。個別のIPアドレス（ホストアドレス）での
> 申請をお願いします。

> **Q: Sandbox環境で固定IPアドレスを持たない場合のアクセス方法はありますか？**
> Sandbox環境でも固定IPアドレスでの登録が必要です。

> **Q: クラウドサービスからAPIにアクセスすることはできますか？**
> 送信元が国内の固定IPアドレスであれば可能です。

### HTTPステータスの意味

> 400エラー : JSON構文エラーやクエリ構文エラー時
> 401エラー : 認証エラー時
> 404エラー : IPアドレス制限等のアクセス拒否時

> **Q: HTTP 400 Bad Request エラーが発生しました**
> ・JSON構文エラー
> ・**Authorizationヘッダーの指定ミス**
> ・**アクセス先の環境とアクセストークンの組み合わせが間違っている**
>   (Sandbox用トークンで本番環境にアクセスすることはできません。逆も同様です)
> ・アクセストークンを発行したアカウントが削除された

→ これを受けて `classifyHttpStatus(400)` を `UNKNOWN_REMOTE_ERROR`
(リトライ対象)から `BAD_REQUEST`(リトライ対象外)へ変更した。
設定ミスのまま4回リクエストを送っていた無駄を止める。

### Webhook送信元IP(別物なので混同しない)

ドキュメントの "Static outbound IP addresses" 節にあるCIDR一覧
(`103.123.182.0/27` 等)は **Mercari → BELLO のwebhook送信元** であり、
> Please allow only these IP addresses for the specified webhook endpoints

と明記されている。**BELLO → Mercari のAPI発信に必要な許可IPとは別の話。**
両方が同時に事実である。

### その他(実装へ反映済み)

- 認証: `Authorization: Bearer <YOUR_PERSONAL_API_ACCESS_TOKEN>` — 実装と一致。
- User-Agent: `{API_CLIENT_NAME}/{VERSION}`、バージョンは任意、無ければ `0.0.0`
  — 実装と一致。API_CLIENT_NAMEは契約時にMercariから提供される事業者識別名で、
  **ショップ名ではない**(こちらで推測・捏造できない)。
- Rate Limit: ショップ単位で 10,000ポイント/時。超過時は `X-Ratelimit-Reset`
  ヘッダでリセット時刻を確認する → 診断情報として保持するようにした。
- アクセストークンに有効期限はない(アカウント削除・管理画面からの削除で失効)。

---

## 4. 保存デッドロックとその解消

### 4.1 何が起きていたか

- `setMercariConnectionAction` は `validateMercariConnection` が成功した
  場合にのみ `setMercariConnectionInSecretsManager` を呼んでいた。
- `validateMercariConnection` は実際にMercariへ `ProductCategories` を投げる。
- 未登録IPからはそれが必ず404になる(§2.1、TOKENの内容に依存しない)。
- よって **保存に到達する経路が存在しない。**

**裏付け:** Secret `bello/mercari-access-token` の `LastChangedDate` は
`2026-08-29T22:51:49+09:00`(CDKによる作成時)のままで、中身は
`{"configured": false}` のみ(キーは `configured` 1つだけ)。
**利用者の保存操作は一度も成功していない。**

### 4.2 直した内容

失敗の**種類**で扱いを分ける(`lib/listing/mercari/connectionPolicy.ts`)。

| 接続確認の結果 | 既存の検証済み設定 | 動作 |
| --- | --- | --- |
| 成功 | 有無を問わず | 検証済みとして保存 (`CONNECTED`) |
| `AUTH_FAILED` / `BAD_REQUEST` (TOKENが拒否された) | 有無を問わず | **保存しない** |
| その他(404/ネットワーク/タイムアウト/レート制限/想定外応答) | なし | **未検証として保存** (`SAVED_UNVERIFIED`) |
| その他(同上) | あり | **上書きしない**(§92の既存意図を維持) |

- Secretのpayloadへ `verified` / `lastCheckedAt` / `lastCheckCode` を追加。
  後方互換: `verified` が無い既存payloadは「検証済み」とみなす
  (当時の保存経路は検証成功時にしか書き込まなかったため)。
- 設定画面の状態を **未設定 / 接続済み / 設定済み（未検証） / 設定を確認できません**
  の4状態へ分離。「未検証」を「接続済み」と偽らない。
- **「接続確認」ボタンを追加** —— IP登録が完了した後、TOKENを入力し直さずに
  接続確認だけを再実行でき、成功すれば `verified` が立つ。

---

## 5. `Cannot read properties of undefined (reading 'success')` の解消

### 5.1 経路

`MercariSettingsPanel.tsx` が

```ts
const res = await setMercariConnectionAction({...});
setMessage({ kind: res.success ? "success" : "error", text: res.message });
```

としており、`res` が `undefined` だとこの行自体が `TypeError` を投げる。
それが同関数の `catch (err)` に拾われ、`err.message` —— すなわち
`Cannot read properties of undefined (reading 'success')` —— が
**そのまま画面のエラー文言として表示される**。報告された文言と完全に一致する。

### 5.2 直した内容(§3.3)

- **Server Action側**: 例外を投げない契約にした。全体を `try/catch` で包み、
  `requireAdmin()` の `throw` も含め、あらゆる経路が判別可能な結果
  オブジェクトを返す。`params` が欠損していてもTypeErrorにしない。
- **結果contractの明示**: 判別可能なunion(`success: true` 側は
  `CONNECTED` / `SAVED_UNVERIFIED` / `DELETED`、`success: false` 側は
  `errorCode` + `retryable` + `checkedAt`)。
- **UI側**: 戻り値を無条件に `.success` 参照せず、
  「オブジェクトで `success` が真偽値」であることを確認してから読む。
  型どおりでなければ日本語の安全な文言へ畳む。
- **例外時のUI文言**: 生の例外メッセージを画面へ出さない
  (「通信状況を確認するか、ログインし直してから再試行してください」)。

### 5.3 その他ここで直した堅牢性の問題

| 問題 | 直し方 |
| --- | --- |
| HTTP 200なのに本文が非JSONだと `response.json()` の生の `SyntaxError` が外へ漏れ、`Unexpected token < in JSON...` が画面に出得た | `INVALID_RESPONSE` として分類済みのエラーへ畳む |
| タイムアウト(AbortError)が `NETWORK_ERROR` と同一視され、文言が `This operation was aborted` になり得た | `TIMEOUT` として分離 |
| エラー本文を丸ごと保持(エッジは1MB超のHTMLを返し得る) | 500文字で切り詰め、省略した旨を明示 |
| `MERCARI_TIMEOUT_MS` に数値以外が入ると `setTimeout(fn, NaN)` = 即時abort となり、原因不明の失敗が続く | 不正値は既定値へフォールバック |
| `getMercariConnectionFromSecretsManager` が **読み取り失敗をすべて握り潰し**、権限不足・認証切れでも画面に「未設定」と出ていた(§6.1のsilent failure) | `readMercariConnectionSecret()` で「未設定」と「読めなかった」を型として分離し、画面は「設定を確認できません」+理由を表示 |
| 設定ページが同一Secretへ `GetSecretValue` を2回発行していた | `getMercariConnectionState()` で1回に集約 |

---

## 6. 【要判断】固定IPが必要な場合の構成 — 承認待ち

**インフラは一切作成していない。** 以下は判断材料のみ。

### 6.1 なぜ従来案では足りないか

以前の記録は「VPC + NAT Gateway + Elastic IP」を挙げていたが、
§3の公式記載により **それだけでは要件を満たさない**:

- 許可IPは **日本国内の固定IPアドレス** でなければならない。
- BELLOのAWSリソースは **`us-west-2`(米国オレゴン)**。
  ここでEIPを取得しても **米国のIP** であり、申請が通らない見込み。
- **他社と共有しているIPは不可** —— 共有型のプロキシ/VPNサービスは使えない。
- **範囲指定不可** —— 個別のホストアドレスを申請する。
  したがってNAT Gatewayは **1つのEIPに固定** する必要がある
  (複数AZに置くとAZごとに別IPになり、申請対象が増える)。
- sandboxと本番で **別々に** 申請・管理が必要。

### 6.2 取り得る選択肢(いずれも未実施・要承認)

| 案 | 概要 | 継続コストの種類 | 主な論点 |
| --- | --- | --- | --- |
| A | `ap-northeast-1`(東京)にVPC + NAT Gateway + EIPを作り、Mercari呼び出しだけをそこのLambdaへ寄せる | NAT Gatewayの時間課金 + データ処理量課金 + EIP | 日本のIPになる。BELLO本体(us-west-2)からのクロスリージョン呼び出しが増える |
| B | 東京リージョンに小さなEC2(またはFargate)を1台置き、EIPを付けてMercari APIの中継のみを行う | インスタンス時間課金 + EIP | 常時稼働。管理対象が増える |
| C | AWS以外の日本国内固定IPを持つ回線/専用サーバを中継に使う | 契約による | 「他社と共有していない」要件の確認が必要 |
| D | Mercari連携を保留する | 0 | EC出品機能のうちMercari分が使えないままになる |

いずれも **新規の有料インフラ作成** に当たるため、指示書§1.2により
**本人の承認なしには実行しない**。金額は構成と転送量で変わるため、
承認いただけるなら案を1つに絞ったうえで見積もりを出す。

### 6.3 IAM権限は足りている（保存できない原因ではない）

「保存できないのはIAM権限が無いからでは」という別の仮説を潰しておく。
Staging SSRコンピュートの実行ロール
`BelloAmplifyStagingComputeRole` のインラインポリシー
`BelloComputeRuntimeAccess` に、次が実際に付与されていることを確認した:

```
Sid: BelloMercariAndLineSecretAccess
Action: secretsmanager:GetSecretValue, secretsmanager:PutSecretValue
Resource:
  arn:aws:secretsmanager:us-west-2:203918843421:secret:bello/mercari-access-token-??????
  arn:aws:secretsmanager:us-west-2:203918843421:secret:bello/line-channel-secret-??????
```

**読み書きの両方が許可されている。** Secretの実体も既に存在するため
`CreateSecret` は不要。つまりIAMは保存できない理由ではなく、
原因は「接続確認に成功しないと保存しない」という設計と、
IP制限で接続確認が成功し得ないことの組み合わせだけだった(§4.1)。

裏を返すと、**§4.2の修正で、TOKENを入力すれば実際に保存できる**
(未検証状態で保存され、IP登録後に「接続確認」を押せば接続済みになる)。

### 6.4 コード側は準備済み

上記の判断がどうなっても、**コード側の作業は完了している**:
IP登録が済んだ時点で、設定画面でTOKENを保存し(未検証状態で保存できる)、
「接続確認」を押せば `verified` が立ち、`接続済み` になる。

---

## 7. 状態分類

| 項目 | 状態 |
| --- | --- |
| `undefined.success` の解消 | **COMPLETE**(コード上で発生し得ない契約にし、テストで固定) |
| 保存デッドロックの解消 | **COMPLETE**(未検証保存 + 接続確認ボタン) |
| エラー分類・堅牢性(400/timeout/非JSON/巨大本文/NaN) | **COMPLETE** |
| Secret読み取り失敗のsilent failure | **COMPLETE** |
| 404の原因特定 | **VERIFIED**(実測 + 一次資料。ただしBELLOのIPの登録状況自体は我々からは観測不能) |
| 実TOKENでのE2E | **BLOCKED_BY_EXTERNAL_SERVICE**(IP申請が前提。TOKEN入力だけでは到達できない) |
| IAM(Secret読み書き権限) | **VERIFIED**(GetSecretValue/PutSecretValue とも付与済み。保存できない原因ではなかった) |
| Staging設定画面のUI確認 | **BLOCKED_BY_USER**(ADMINログイン済みセッションへClaude Codeから到達できず、画面操作を伴うE2Eは未実施) |
| 固定IPインフラ | **BLOCKED_BY_USER**(有料インフラの新設は承認が必要) |
