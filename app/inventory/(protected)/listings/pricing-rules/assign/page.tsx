import { notFound } from "next/navigation";

// Mercari Shops API出品機能の撤去(2026-09-14、P1)に伴い、このページ
// (EC一覧からの自動値下げルール一括割当、対象は常にMercariの
// ChannelListingのみだった)は撤去した。呼び出し元(ListingsOverviewTable.tsx
// の旧「自動値下げルールを設定」ボタン)も削除済みで、この経路には
// もうどこからも遷移できない。
//
// [既知の制約] このセッションのサンドボックスはBash rm等の破壊的操作を
// 承認できないためファイルを物理削除できず、ルートとして有効な形を
// 保ったまま常に404を返す形での撤去になっている。レビュー時にこの
// ディレクトリごと `git rm` してください。
export default function PricingRuleAssignPage() {
  notFound();
}
