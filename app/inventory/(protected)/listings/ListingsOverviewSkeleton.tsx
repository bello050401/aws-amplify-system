/**
 * EC一覧P1 レビュー補正(2026-09-13): page.tsxの<Suspense>fallback。
 *
 * app/inventory/(protected)/loading.tsxと同じ「骨格だけ」の考え方 —
 * 実際のツールバー(検索欄・状態フィルタ・件数表示)とほぼ同じ形にして
 * おくことで、データ到着時にレイアウトが大きくガタつかない。canEdit
 * を受け取るのは、一括操作ボタン列の有無で骨格の高さが変わらないよう
 * にするため(本体側ListingsOverviewTableの実際の分岐と揃える)。
 */
export function ListingsOverviewSkeleton({ canEdit }: { canEdit: boolean }) {
  return (
    <div aria-busy="true" aria-live="polite">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="h-7 w-64 animate-pulse rounded bg-gray-100" />
        <div className="h-7 w-32 animate-pulse rounded bg-gray-100" />
        <div className="h-4 w-16 animate-pulse rounded bg-gray-100" />
        {canEdit && <div className="ml-auto h-7 w-72 animate-pulse rounded bg-gray-100" />}
      </div>
      <div className="border border-gray-200">
        <div className="h-8 border-b border-gray-200 bg-gray-50" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex h-[60px] items-center gap-3 border-b border-gray-100 px-2">
            <div className="h-[60px] w-[90px] shrink-0 animate-pulse rounded bg-gray-100" />
            <div className="h-4 w-1/3 animate-pulse rounded bg-gray-100" />
          </div>
        ))}
      </div>
      <span className="sr-only">EC出品一覧を読み込み中</span>
    </div>
  );
}
