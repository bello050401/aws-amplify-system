# メルカリShops画像登録HTTP観測（2026-10-12）

本人が通常ChromeでNetwork記録中に、既存の非公開下書きへ画像を1枚追加した。管理画面は「下書きに保存しました」と表示し、同じ下書きIDのまま画像が2枚になった。その直後に検証用の重複画像を取り除き、元の1枚へ戻した。新規商品作成・公開は行っていない。

本人提供のDesktop HARはローカルだけで解析した。認証値、Cookie、商品ID、画像内容、画像asset IDはこの文書・通常ログ・Gitに転記しない。

## 実測した送信順序と形

1. `POST https://mercari-shops.com/graphql`、`multipart/form-data`、GraphQL `CreateImageAsset`。要求の `operations` は `CreateImageAsset($input: CreateAssetInput!)`、入力キーは `file: null`、`protectionKind: "none"`、`public: true`。`map` は `{"1":["variables.input.file"]}`。ファイル部は名前 `1`、ファイル名 `blob`、Content-Type `image/jpeg`。HARにはmultipart要求本文が存在したが、画像バイトは転記しない。HTTP 200の応答には `data.createImageAsset.id` と `contentType` がある。
2. 直後にJSONの `UpdateProductDraft` がHTTP 200となり、`data.updateProductDraft` が返った。画像を下書きへ紐付ける更新は画像asset登録と別の要求である。
3. 管理画面に保存成功の表示が出た。検証用の重複画像を除去した後、元画像1枚の表示を確認した。

Chromeのsanitized HARにはこの画像要求のCookie、Authorization、CSRF名のヘッダーが残っていない。**認証不要という意味ではない**。Shops管理画面の実行中セッションで成功した事実だけを示す。Cookie取得・更新方法、長期間の再認証不要、BELLOサーバーからの同一要求成功は未確認。

`webHttpObservedImageAsset.ts` は上記のmultipartを**送信せずに**組み立てるサーバー専用の部品である。原画像のSHA-256を照合し、同じ画面ビルドの静的JSで見えた最大1600×1600・JPEG品質0.8に合わせてサーバー側で準備する。Sharpと画面のcanvasは異なるエンコーダーなのでバイト同一性は主張しない。準備済みJPEGのSHA-256と形式を検査し、成功応答のasset IDを厳密に読み取る。アップロードした元ファイルは218,226バイトだが、HARのmultipart画像部は約88KBであり、画面側の画像変換が行われた可能性がある。ただしsanitized HARのバイナリ本文は文字置換があり、内容の一致までは確認できない。BELLOのEC出品ボタンや本番アダプターには接続していない。認証済み送信、下書き更新との一貫処理、結果不明時の重複防止は別途実証が必要である。

その後、`webHttpObservedImageUpload.ts` に固定送信先のサーバーHTTPSアップロード部品を追加した。準備済み画像の工程別予約、送信前の認証・対象照合、一度限りの送信宣言、応答asset IDの条件付き永続化までを注入ポートの試験で確認した。応答や保存結果が不明なら再送しない。これは**本番アダプター未接続のコード試験**であり、BELLOサーバーからShopsへの実送信成功を意味しない。原画像の読取証明、継続認証、下書き更新、出品・停止はまだ別途必要である。
