export function LoadingOverlay({ label = "読み込み中..." }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-bello-600">
      <div className="bello-spinner h-8 w-8 rounded-full border-4 border-bello-200 border-t-bello-600" />
      <p className="text-sm">{label}</p>
    </div>
  );
}

export function InlineSpinner({ className = "" }: { className?: string }) {
  return (
    <span
      className={`bello-spinner inline-block h-4 w-4 rounded-full border-2 border-white/40 border-t-white ${className}`}
    />
  );
}

export function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-white p-3 shadow-card animate-pulse">
      <div className="h-14 w-14 shrink-0 rounded-xl bg-bello-100" />
      <div className="flex-1 space-y-2">
        <div className="h-3 w-1/3 rounded bg-bello-100" />
        <div className="h-4 w-2/3 rounded bg-bello-100" />
      </div>
      <div className="h-8 w-14 rounded bg-bello-100" />
    </div>
  );
}
