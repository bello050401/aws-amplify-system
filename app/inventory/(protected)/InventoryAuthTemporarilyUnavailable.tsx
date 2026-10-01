/** Displayed only after a known Cognito rate limit. A plain link performs a
 * new request when the user chooses to retry; there is no automatic retry. */
export function InventoryAuthTemporarilyUnavailable({ reason = "rate-limit" }: { reason?: "rate-limit" | "session-check" }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-6 text-center">
      <div>
        <h1 className="text-sm font-bold text-gray-900">{reason === "session-check" ? "認証状態を確認できませんでした" : "認証サービスが一時的に混み合っています"}</h1>
        <p className="mt-2 text-xs text-gray-600">しばらく待ってから、画面を再読み込みしてください。</p>
        <a href="" className="mt-4 inline-block border border-gray-900 px-4 py-1.5 text-xs font-bold text-gray-900">再試行</a>
      </div>
    </div>
  );
}
