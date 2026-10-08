# B005396画像アップロード: HARと同一ビルドの静的JS（2026-10-09）

対象は本人のローカルHARに記録されたメルカリShops商品登録ページの通信。HAR原本、画像、認証値、静的JS原文はリポジトリに保存していない。静的JSはHAR内の応答本文をメモリ内で読み、同じハッシュ付きURLを認証なしで取得してSHA-256一致を確認した。

## HARで直接観測した事実

- HAR entry 357: 商品登録ページを参照元とする `POST https://mercari-shops.com/graphql`。Content-Typeは `multipart/form-data`、HTTP 200、GraphQLエラーなし。応答の `data.createImageAsset` に `id` と `contentType` がある。
- このentryには `postData` がない。ファイルバイト、multipartの各部、GraphQL変数の実値、画像前処理後のバイト同一性は直接観測できない。
- 続く `UpdateProductDraft` は `assetIds` 1件を送り、応答で下書きの画像1件を返した。画像が対象下書きに紐付いたことは観測できるが、BELLOの元画像との一致は未証明。

## 同一ビルドの静的JSから読める実装

| 静的ファイル | HARとの対応 | 読み取れた内容 |
| --- | --- | --- |
| [chunk 30029](https://mercari-shops.com/_next/static/chunks/30029-76566c694e53dc8c.js) | 商品登録ページがHAR entry 28で読み込み、entry 484に本文。SHA-256 `4602fd787d1366aa0bb00573d7d1469ecb62c6ee8433ae63d02380ff18bc6a84` | `CreateImageAsset($input: CreateAssetInput!)` mutationが `createImageAsset(input: $input)` の `id` と `contentType` を要求する。 |
| [chunk 24443](https://mercari-shops.com/_next/static/chunks/24443-7563ee2c3f1fdc69.js) | 商品登録ページがHAR entry 33で読み込み、entry 488のbase64本文を復号して照合。SHA-256 `08805c2858bf7af6c9129c1cd30b959e5a5d0a0916612fceb72c17b0422c97e5` | 画像アップロード関数は画像を正規化してから `variables.input` に `file`、`protectionKind`、`public` を組み立てる。画面側は追加オプションなしでその関数を呼ぶため、ソース上の既定値は `isPublic=true`、`protectionKind="none"`、`public=true`。 |
| [共通アプリchunk](https://mercari-shops.com/_next/static/chunks/pages/_app-f6363a86c5fcba20.js) | 商品登録ページがHAR entry 6で読み込み、entry 419に本文。SHA-256 `f7621a090c3298b1cda810668dc6284013e1dadc45cfd31414591eac46f69689` | ファイルを含むGraphQL要求ではアップロードクライアントが `FormData` を作り、`operations`、`map`、ファイルpartを追加する実装。 |

これらは**静的ソースの実装**であり、HARで欠けた実際のmultipart本文を復元したものではない。特に `file` の具体的な値、送信時の `operations` / `map` の内容、画像の変換結果、認証方法は未確認。GraphQL文書中の `@auth` からCookieやトークンの取得方法は推定しない。静的JSだけを根拠にアップロードを送信しない。
