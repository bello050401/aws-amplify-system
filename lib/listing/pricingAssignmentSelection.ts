// Mercari Shops API出品機能の撤去(2026-09-14、P1)に伴い、この
// 「EC出品一覧 → 自動値下げルール一括割当ページへの選択商品ID引き渡し」
// は撤去した。割当先だった/inventory/listings/pricing-rules/assign(対象は
// 常にMercariのChannelListingのみ)を削除したのに伴う——理由は
// ../../app/inventory/(protected)/[id]/listing/AutoPricingSection.tsx
// 冒頭コメント参照。呼び出し元(ListingsOverviewTable.tsxのgoToPricingRuleAssignment)
// も削除済みで、このファイルはもうどこからもimportされていない。
//
// [既知の制約] このタスクの実行セッションのサンドボックスは破壊的な
// Bash操作(rm/unlink等)を承認できない環境のため、ファイルを物理削除
// できず、中身を空にする形での撤去になっている。レビュー時に
// このファイルを `git rm` してください。
export {};
