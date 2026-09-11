/**
 * 2026-09-09 追加指示(§5 速度): 売上ページ用の待機案内(App Router
 * loading.tsx)。
 *
 * app/inventory/(protected)/loading.tsx(在庫一覧側)は既に同じ理由で
 * 用意されているが、売上ページ(app/inventory/(protected)/sales)には
 * 無く、当月データの取得が終わるまで画面には何のフィードバックも出ない
 * まま応答を待つだけになっていた。データや検索条件は一切変えず、遷移が
 * 始まったことだけを伝える。
 *
 * 2026-09-11追加修正: ページ本体(page.tsx)が呼ぶlib/inventory/salesView.ts
 * のloadSalesSummaryは集計テーブルへのGetItem(1回)のみで、Inventoryへの
 * 走査は行わない——このloading表示が出ている間の実処理は従来より大幅に
 * 軽い(対象商品一覧は別途ユーザーが明示的に開くまで取得しない、
 * SalesItemsSection.tsx参照)。
 */
export default function SalesLoading() {
  return (
    <div className="flex h-full flex-col" aria-busy="true" aria-live="polite">
      <div className="flex h-[var(--inventory-header-height)] shrink-0 items-center gap-3 border-b border-gray-200 px-4">
        <div className="h-4 w-32 animate-pulse rounded bg-gray-200" />
        <div className="h-6 w-40 animate-pulse rounded bg-gray-100" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mb-4 h-8 w-56 animate-pulse rounded bg-gray-100" />
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded bg-gray-100" />
          ))}
        </div>
        <div className="mb-6 h-64 w-full animate-pulse rounded bg-gray-100" />
        <div className="space-y-1.5">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-8 w-full animate-pulse rounded bg-gray-100" />
          ))}
        </div>
      </div>
      <span className="sr-only">読み込み中</span>
    </div>
  );
}
