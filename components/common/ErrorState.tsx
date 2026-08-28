export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl bg-danger-50 px-6 py-10 text-center">
      <div className="text-3xl">⚠️</div>
      <p className="text-sm font-medium text-danger-600">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="tap-target rounded-full bg-danger-500 px-5 py-2 text-sm font-semibold text-white active:bg-danger-600"
        >
          再試行する
        </button>
      )}
    </div>
  );
}

/** APIエラーを人が読めるメッセージへ変換する共通ヘルパー(指示書 §22) */
export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "通信エラーが発生しました。もう一度お試しください。";
}
