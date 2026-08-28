"use client";

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "実行する",
  cancelLabel = "キャンセル",
  danger = false,
  loading = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center" role="dialog" aria-modal>
      <div className="w-full max-w-sm rounded-t-3xl bg-white p-6 pb-safe-nav shadow-floating md:rounded-3xl">
        <h2 className="text-base font-bold text-bello-900">{title}</h2>
        {description && <p className="mt-2 text-sm text-bello-500">{description}</p>}
        <div className="mt-6 flex gap-3">
          <button
            onClick={onCancel}
            disabled={loading}
            className="tap-target flex-1 rounded-full border border-bello-200 py-3 text-sm font-semibold text-bello-700 active:bg-bello-50"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={`tap-target flex-1 rounded-full py-3 text-sm font-semibold text-white disabled:opacity-60 ${
              danger ? "bg-danger-500 active:bg-danger-600" : "bg-bello-700 active:bg-bello-800"
            }`}
          >
            {loading ? "処理中..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
