/** 商品詳細の骨格。理由は app/inventory/(protected)/loading.tsx と同じ。 */
export default function InventoryDetailLoading() {
  return (
    <div className="flex h-full flex-col" aria-busy="true" aria-live="polite">
      <div className="flex h-[var(--inventory-header-height)] shrink-0 items-center border-b border-gray-200 px-4">
        <div className="h-4 w-48 animate-pulse rounded bg-gray-200" />
      </div>
      <div className="flex flex-1 flex-col gap-4 p-4 md:flex-row">
        <div className="h-64 w-full animate-pulse rounded bg-gray-100 md:w-80" />
        <div className="flex-1">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="mb-2 h-5 w-full max-w-xl animate-pulse rounded bg-gray-100" />
          ))}
        </div>
      </div>
      <span className="sr-only">読み込み中</span>
    </div>
  );
}
