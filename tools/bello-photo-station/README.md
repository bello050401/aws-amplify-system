# BELLO Photo Station 接続クライアント

Windows撮影端末から画像登録APIへ安全に送るための最小クライアント基盤です。SD差分検出(`windows/`側のImportService)・Lightroom加工そのものとは分離し、次を行います。

1. 端末ローカルの編集設定を読み込む(`src/settings.mjs`。初期値は「原比率維持・自動トリミングなし・方向正規化・sRGB・JPEG・長辺3000px/品質90・サムネイル480px/品質80・GPS及び個人情報の削除」)
2. Lightroom未接続時の基本編集(リサイズ・EXIF方向正規化・メタデータ削除・簡易トーン補正)を`sharp`で実行する(`src/processImage.mjs`)。原本は読み取り専用で扱い、書き込みは`processed/`・`thumbnails/`にだけ行う
3. 取込セッションIDを固定してPhotoBatchを作成
4. 25件ずつupload URLを要求し、presigned URLへ直接PUT
5. 画像単位の完了通知、重複除外後の枚数でbatch完了通知
6. 原本ハッシュ＋設定ハッシュ単位の処理/送信履歴をJSON checkpointへ記録し、同じ原本・同じ設定の再処理と二重送信を避ける(`src/history.mjs`)
7. `src/runPipeline.mjs`が2〜6をまとめて実行し、`src/cli.mjs`(`node src/cli.mjs --session-id ... --source-dir ... ...`)からWindowsデスクトップ側のサブプロセスとして呼び出せる

API URLはHTTPSのみを許可します。Cognitoトークンは環境変数`BELLO_PHOTO_STATION_TOKEN`など呼出側の短期token providerから受け取り、固定AWSアクセスキーを保存しません。Inventory選択、実出品、ZAICO、外部通知は行いません。背景生成・背景抜き・傷消し・商品形状変更は行いません。

```powershell
cd tools/bello-photo-station
npm install   # sharpの取得に必要(初回のみ)
npm test
```

実AWS接続には、隔離stagingのHTTPS endpointとPHOTO_DEVICE用ログインフローが必要です。未設定のまま実ネットワークへ接続する処理はありません。`npm test`は`sharp`で生成した合成JPEGとfetchのfakeだけを使い、実S3/Cognito/実商品写真には一切触れません。

`src/cli.mjs` を直接実行(`node src/cli.mjs ...`)した場合、標準出力の最終行に `RESULT_JSON:` 接頭辞付きで
`main()`の戻り値がそのまま出力され、status が `FAILED`/`PARTIAL` なら非ゼロ終了する
(Windowsデスクトップ側 `windows/src/PhotoStation.Infrastructure/NodeCliPipelineRunner.cs` がこの行だけを
構造化結果として解析する契約)。`src/previewCli.mjs` は設定画面の「テスト画像1枚によるプレビュー」用に
1枚だけ processImage を実行するCLIで、同じ `RESULT_JSON:` 契約を持つ。

> **このセッションでの制約**: `npm install`(および `dotnet`)がこの開発セッションでは承認ゲートで拒否され、
> `node_modules`(`sharp`)が存在しないため、`sharp`に依存するテスト(`processImage.test.mjs`・
> `cli.test.mjs`・`previewCli.test.mjs`の一部)はこのセッションでは実行できていない。`sharp`に依存しない
> 部分(`settings.test.mjs`・`history.test.mjs`・`summary.test.mjs`・`previewCli.mjs`の引数解析)は
> `node --test`で実行し15件成功を確認済み。`npm install`が可能な環境で改めて`npm test`を実行すること。
