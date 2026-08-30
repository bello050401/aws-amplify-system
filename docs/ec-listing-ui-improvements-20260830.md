# EC出品UI改善記録(一覧の操作導線・詳細の画像・在庫詳細への導線)

作成日: 2026-08-30。対応指示書: 「不具合修正・ZAICO同期重複根絶・
EC出品UI改善・画像自動加工 完全自律実装指示書」§8/§9/§10。

## §8: EC出品一覧の操作導線改善

`app/inventory/(protected)/listings/ListingsOverviewTable.tsx`:

- 末尾列の「詳細を開く」リンクを削除し、商品名(`row.name`)自体を
  `/inventory/${row.inventoryId}/listing`へのリンクにした。
- `Link`はネイティブに`<a>`を描画するため、hover/focus(下線色の変化+
  `focus-visible:ring`)・キーボード操作(Tab移動+Enter実行)・
  スクリーンリーダーでの読み上げ(リンクテキスト=商品名)を追加実装
  無しで満たす。
- 既存の行操作(選択チェックボックス・サムネイル画像)とは独立した
  要素なので干渉しない——チェックボックスは既存の一括操作
  (出品下書き一括作成/自動値下げルール一括設定)に引き続き使われる、
  この画面固有の正当な用途を持つチェックボックスであり、doc §7の
  対象(在庫一覧のチェックボックス)とは別物。
- 列を1つ減らしたため、ヘッダーの`<th>`数・空状態の`colSpan`
  (8列/7列)を合わせて修正した。

## §9: EC出品詳細の商品画像

`app/inventory/(protected)/[id]/listing/page.tsx`/`ListingForm.tsx`:

- 在庫詳細ページ(`app/inventory/(protected)/[id]/page.tsx`)が既に
  使っている`InventoryImageGallery`コンポーネントをそのまま再利用
  した——メイン画像・複数画像時のサムネイル閲覧・ライトボックス・
  「No Image」プレースホルダーを標準装備しており、今回新規に実装した
  ものは無い。
- 画像の並び順(トップ画像を先頭に)も在庫詳細ページと全く同じ
  `splitImagesByType`+`resolveTopImage`ロジックを再利用し、2画面で
  表示規約が食い違わないようにした。
- 原則「画像データをEC Listing側へ不要に複製しない」を厳守——
  `page.tsx`(Server Component)が`getInventoryDetail`で取得した
  Inventory本体の`images`をそのまま`ListingForm`へ渡すだけで、
  ChannelListing/ListingDraftへ画像を書き込む経路は増やしていない。
- 既存のS3署名URL/thumbnailアーキテクチャ(`InventoryThumbnail`/
  `useInventoryImageUrl`)をそのまま使うため、画像の高速表示
  (Phase B優先度)を壊していない。

## §10: EC出品詳細 → BELLO在庫詳細への導線

`app/inventory/(protected)/[id]/listing/page.tsx`のコンテンツ先頭に
「← 在庫詳細を開く」リンクを追加した。紐付けは`item.id`(一意キー、
`getInventoryDetail`が返すInventory本体のid)を直接使うリンク先
(`/inventory/${item.id}`)であり、商品名やSKUによる曖昧検索は一切
行わない。

## テスト・検証

- `tsc --noEmit`/`next lint`: green。
- `npm run build`(production): green、ページ一覧に変化なし
  (既存ルートの中身だけを変更、新規ルートは追加していない)。
- 手動でのUIロジック確認(列数/colSpanの整合性、既存
  `InventoryImageGallery`の呼び出しシグネチャが在庫詳細ページと一致
  していること)をコードレビューで実施。専用のPlaywright E2Eテストは
  今回追加していない(既存の`e2e/inventory-mobile.spec.ts`は
  `/inventory`関連ルートのみを対象にしており、EC出品一覧/詳細は
  E2E fixtureの対象外——スコープ外の新規テスト基盤追加は見送った)。

## 正直な残課題

- 実際のMercari接続がBLOCKED(`docs/mercari-404-root-cause-20260830.md`
  参照)のため、実出品済み商品の画像・外部リンク等を含む完全なE2E
  確認はできていない——ChannelListing/ListingDraftのfixtureデータでの
  ロジック確認に留まる。
- EC出品一覧テーブル自体のモバイル最適化(P0-4のInventoryCardList相当
  のカード化)は今回のスコープ外——テーブルは引き続き
  `overflow-x-auto`の横スクロール式のままだが、タイトルリンクは
  タップ可能なテキスト要素として機能する。
