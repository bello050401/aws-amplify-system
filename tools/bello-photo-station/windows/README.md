# BELLO Photo Station Windows

撮影PC向けの `.NET 10 / WPF / x64` 実装です。SD原本を変更せず、ローカルSSDへコピーしてSHA-256を再読込照合し、SQLite台帳へ確定します。Inventory選択や商品変更は行いません。

## 現在の実装

- removable driveまたは明示したカードrootの検出
- DCIMのARW/JPEGスナップショット
- 同一カード世代・相対path・size・mtimeによる差分判定
- 固定manifestから決定的session IDを生成し、同一取込の重複を防止
- `.partial`へのコピー、flush、再読込SHA-256照合、同一volume rename
- SQLite WAL台帳、工程状態機械、単一起動Mutex
- staging専用画面、取込履歴、SD取外し可能表示
- 別PCへ持ち込めるself-contained win-x64単一ファイルpublish

## 設定

端末固有値はソースへ埋め込みません。稼働PCで次を設定します。

|環境変数|用途|
|---|---|
|`BELLO_PHOTO_STATION_ROOT`|SQLite・session原本の保存root。未設定時はLocalAppDataのstaging領域|
|`BELLO_PHOTO_STATION_ID`|登録済み撮影端末ID。未設定時は `UNREGISTERED-STATION`|
|`BELLO_PHOTO_CARD_ROOT`|Fixed扱いになるカードリーダーを明示する場合のdrive root|

productionの接続情報や認証情報は含めていません。現previewはstaging専用です。

## ビルドとテスト

```powershell
dotnet test BelloPhotoStation.slnx --configuration Release
dotnet publish src/PhotoStation.Desktop/PhotoStation.Desktop.csproj --configuration Release --runtime win-x64 --self-contained true -p:PublishSingleFile=true
```

実機Lightroom Classic連携、画像現像・加工、Credential Managerを使うCognitoログイン、署名付きinstallerは未実施です。これらは実稼働PCとAdobeログインが必要な受入れ工程として分離しています。
