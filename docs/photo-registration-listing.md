# 画像登録 Phase 1 — 商品詳細・Listing・CSV/ZIP 統合

## 実装済み

- 商品詳細は、従来の Inventory 画像を維持したまま、リンク済みかつ READY の PhotoAsset を追加表示する。
- PhotoAsset の表示URLが失効した場合は、画面上の「再取得」から server action を再実行して短期署名URLを更新する。
- Listing 画面は Inventory 画像と PhotoAsset を同じ候補一覧で扱い、最大20枚まで選択、並べ替え、主画像（先頭）設定ができる。
- 旧 ListingDraft の `source` 未設定画像は Inventory 画像として復元し、既存データとの互換を維持する。
- 下書き保存時は選択順を `ListingDraft.images` に保存し、PhotoAsset の選択は `PhotoRegistrationService.setListingImageSelection` の条件付き transaction を通して参照カウンタへ反映する。後段が失敗した場合は成功表示にしない。
- Mercari CSV と画像ZIPは保存済み `source` を使って Inventory 用 Amplify Storage と PhotoAsset 用S3を振り分ける。PhotoAssetを再アップロードせず processed key を利用する。
- PhotoAssetを含む処理で画像登録環境変数が未設定の場合は fail closed とし、一部だけのリンクやZIPを返さない。

## 互換性と安全境界

- Inventory画像だけの商品は従来どおり動作する。
- 画像登録基盤が未接続、または対象PhotoAssetが0件の場合、商品詳細の追加ギャラリーは表示せず既存画面を維持する。
- 論理削除済み、READY以外、傷画像は出品候補から除外する。
- 認証ロールはクライアント入力を受け取らず、既存のサーバー認証コンテキストから構成する。
- この工程ではAWS操作、実出品、外部送信、依存追加を行っていない。

## 検証結果

- `verify-photo-registration-listing.ts`: 10/10 成功
- `verify-photo-registration-web.ts`: 19/19 成功
- `verify-photo-registration-api.ts`: 26/26 成功
- TypeScript `--noEmit`: 成功

検証は外部I/Oを行わない合成データで、既存のみ・PhotoAssetのみ・混在、順序と主画像、旧データ復元、論理削除除外、参照ID順序を確認した。AWS stagingでの実結合は後続工程で行う。
