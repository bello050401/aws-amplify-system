# BELLO セキュリティ点検（2026-09-04）

机上の可能性を並べるのではなく、**現在のコードで現実に成立するか**を基準に見ています。
成立しないものは「成立しない理由」まで書きました。

---

## 1. 結論

**未認証で到達できる破壊的操作・情報漏洩は見つかりませんでした。**

修正したのは1点で、それも「現時点では突破できないが、守りが下位レイヤ1本に
ぶら下がっていて将来消えうる」という予防的なものです。

---

## 2. 到達面（外部から叩けるもの）の棚卸し

| 種類 | 数 | 認可の有無 |
|---|---|---|
| APIルート（Route Handler） | 5 | **すべて確認済み** |
| Server Action（POSTエンドポイントとして公開される） | 30ファイル | 入口ガードが無かった2ファイルを修正、他は元から有り |
| 公開ページ | `/features/[slug]` のみ | 意図的な公開（apiKeyの読み取り専用） |

### 2.1 APIルート

| ルート | 守り方 |
|---|---|
| `POST /api/line/webhook` | `x-line-signature` を**生の本文**に対して検証。不正なら401 |
| `POST /api/line/notify-webhook` | 同上 |
| `GET /api/base/oauth/start` | `getInventoryRole() === "ADMIN"` |
| `GET /api/base/oauth/callback` | 同上 |
| `GET /api/inventory/export` | `getInventoryRole()` で権限確認 |

LINE Webhookの署名検証を**パース前の生の本文**で行っている点は重要で、
JSONを一度パースして再直列化すると署名が一致しなくなり、検証が形骸化します。
コード内にもその理由が明記されていました。

### 2.2 Server Action

Server Action はページの layout では守られません（layoutが守るのは**描画**であって、
Actionの**呼び出し**ではない）。30ファイルを1つずつ確認したところ、
入口で権限をまったく確かめていないのは2ファイルでした。

| ファイル | 公開関数 | 実際に突破できるか |
|---|---|---|
| `app/actions/base.ts` | 3 | **できない。** BASEトークンを `adminAuthMode`（Cognitoセッション必須）で読むため、未ログインはAppSyncが弾く |
| `app/actions/features.ts` | 8 | **できない。** Feature本体の読み書きが同じく `adminAuthMode`。しかもBedrock呼び出しより**前**にBASEトークンの読み取りが入るので、AI費用を未認証で消費させることもできない |

**現時点の実害は無い**と確認したうえで、他の28ファイルと同じ形（入口で確かめる）へ揃えました。
理由は、その守りが下位レイヤ1本にぶら下がっており、認可モードを変える／トークン読み取りより前に
処理を足す、といった変更で黙って消えるためです。

`base.ts` の検索系2つは throw ではなく戻り値で返しています ——
このファイル自身が「production build では throw した message が英語の定型文へ丸められる」と
記録している方針に合わせました。

---

## 3. 認可モデル

| 層 | 仕組み |
|---|---|
| ページ | route-group layout（`(protected)`）で `getInventoryRole()` / `getSessionStatus()` を確認 |
| Server Action | 各関数の入口で `getInventoryRole()` / `canEditInventory()` / `isAdmin()` |
| データ | AppSync の `allow.group("ADMIN"/"EDITOR"/"VIEWER"/"Admins")`。**最終的な砦はここ** |
| 未認証経路 | LINE Webhook / メール取込は署名検証 → SSR実行ロールのIAMでDynamoDB直結 |

役割は ADMIN / EDITOR / VIEWER の3段で、`canEditInventory` / `canHardDeleteInventory` が
「編集できるか」「物理削除できるか」を一箇所で決めています。物理削除はADMINのみです。

---

## 4. Secret の扱い

| 確認項目 | 結果 |
|---|---|
| ソースへの直書き | **無し**（すべて Secrets Manager 経由） |
| クライアントバンドルへの混入 | 無し（読み取りはすべて `server-only` のモジュール内） |
| ログ・エラーメッセージへの混入 | 確認した範囲で無し。エラーは種別コードのみを出す設計（`WebhookStoreFailure` 等） |
| テストフィクスチャ | Secret値は含まない |
| 実行ロールの権限 | ARNを**明示列挙**（`Resource:"*"` ではない）。`CreateSecret` は意図的に与えていない |

存在するSecret（**値は一切出しません**）:
`bello/zaico-api-token` / `bello/mercari-access-token` / `bello/line-channel-secret` /
`bello/mercari-relay` / `bello/base-app-credentials` / `bello/line-notify-bot` / `bello/gmail-oauth`

第1フェーズで「`bello/mercari-api-token` の作成が必要」と報告していましたが、**これは誤りでした**。
その名前を読んでいたのは計測ハーネス自身（名前の書き間違い）で、アプリが使うのは
`bello/mercari-access-token`（作成済み）です。訂正済みで、**AWS管理者の操作は発生しません**。

DynamoDBへの直結も同じく列挙式で、許されているのは `GetItem` / `Query` / `Scan` の3つ
（書き込み系は会話系の一部テーブルのみ）。`BatchGetItem` は入っていないため、
検索の行取得は同時発行の `GetItem` にしてあります。

---

## 5. 入力の扱い

| 項目 | 状態 |
|---|---|
| Webhook署名 | 生の本文で検証。**再生（replay）対策**は署名検証＋`externalMessageId` の重複判定で担保 |
| URL検証 | 外部調査（research）では `http:`/`https:` 以外を拒否 |
| ファイルアップロード | 画像はMIME・拡張子・サイズを検証したうえでS3の固定プレフィックスへ。パスは組み立て側で決め、利用者入力をそのまま使わない |
| JSONパース | `customFields` / `content` などは try/catch で壊れた値を `null` に畳む（例外で画面ごと落とさない） |
| DynamoDB式 | 属性名は式へ直接埋め込まず、必ず `ExpressionAttributeNames` を通す（`verify:direct-data` で固定） |

---

## 6. 直していないもの（判断が要る／今回の範囲外）

| 項目 | 深刻度 | 理由 |
|---|---|---|
| Server Action のレート制限 | P3 | 現状すべて認証必須。未認証で叩ける入口はWebhook（署名必須）のみ |
| 在庫の同時編集による上書き | P2 | セキュリティというより整合性。競合時の見せ方が仕様判断（`SYSTEM_HEALTH_REPORT.md` §6-1） |
| 会話の同時作成 | P2 | `(channel, externalCustomerId)` のGSIが無く、Scanベースの照合。重複会話は表示上の問題にとどまる |

---

## 7. 残るリスク

- **認可の最終的な砦はAppSyncのスキーマ**です。`amplify/data/resource.ts` の
  `authorization` を緩めると、入口ガードだけでは防ぎきれません。変更時は必ず見直してください。
- **DynamoDB直結の経路はAppSyncのリゾルバを通りません。** AppSyncが自動で付ける振る舞い
  （今回見つかった `attribute_not_exists(id)` のような条件）が、直結側では明示的に書かないと
  付きません。直結の処理を足すときは、AppSync側と同じ意味になっているかを確認してください。
