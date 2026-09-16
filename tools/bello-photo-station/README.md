# BELLO Photo Station 接続クライアント

Windows撮影端末から画像登録APIへ安全に送るための最小クライアント基盤です。SD差分検出・Lightroom加工そのものとは分離し、加工済みJPEGとサムネイルを受け取って次を行います。

1. 取込セッションIDを固定してPhotoBatchを作成
2. 25件ずつupload URLを要求
3. presigned URLへ直接PUT
4. 画像単位の完了通知
5. 重複除外後の枚数でbatch完了通知
6. JSON checkpointを一時ファイルから置換して再開状態を保存

API URLはHTTPSのみを許可します。Cognitoトークンは呼出側の短期token providerから受け取り、固定AWSアクセスキーを保存しません。Inventory選択、実出品、ZAICO、外部通知は行いません。

```powershell
cd tools/bello-photo-station
npm test
```

実AWS接続には、隔離stagingのHTTPS endpointとPHOTO_DEVICE用ログインフローが必要です。未設定のまま実ネットワークへ接続する処理はありません。
