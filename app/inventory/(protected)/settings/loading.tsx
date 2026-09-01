/** 設定画面の骨格。理由は app/inventory/(protected)/loading.tsx と同じ。 */
export default function SettingsLoading() {
  return (
    <div className="flex h-full flex-col" aria-busy="true" aria-live="polite">
      <div className="flex h-[var(--inventory-header-height)] shrink-0 items-center border-b border-gray-200 px-4">
        <div className="h-4 w-24 animate-pulse rounded bg-gray-200" />
      </div>
      <div className="flex-1 px-6 py-4">
        <div className="mb-4 flex flex-wrap gap-3 border-b border-gray-200 pb-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-5 w-20 animate-pulse rounded bg-gray-100" />
          ))}
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="mb-2 h-8 w-full max-w-2xl animate-pulse rounded bg-gray-100" />
        ))}
      </div>
      <span className="sr-only">読み込み中</span>
    </div>
  );
}
