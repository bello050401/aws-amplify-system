export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl bg-white/60 px-6 py-16 text-center">
      <div className="text-4xl">📦</div>
      <p className="text-base font-semibold text-bello-800">{title}</p>
      {description && <p className="max-w-xs text-sm text-bello-500">{description}</p>}
      {action}
    </div>
  );
}
