/** メッセージ画面の骨格。理由は app/inventory/(protected)/loading.tsx と同じ。 */
export default function MessagesLoading() {
  return (
    <div className="flex h-full" aria-busy="true" aria-live="polite">
      <div className="w-72 shrink-0 border-r border-gray-200 p-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="mb-2 h-12 w-full animate-pulse rounded bg-gray-100" />
        ))}
      </div>
      <div className="flex-1 p-4">
        <div className="mb-3 h-5 w-48 animate-pulse rounded bg-gray-200" />
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="mb-2 h-10 w-full max-w-lg animate-pulse rounded bg-gray-100" />
        ))}
      </div>
      <span className="sr-only">読み込み中</span>
    </div>
  );
}
