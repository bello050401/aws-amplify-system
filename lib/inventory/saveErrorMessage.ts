/** A transport failure cannot tell us whether the server completed the write. */
export function inventorySaveErrorMessage(error: unknown, fallback: string): string {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "【圏外です】入力内容は保持しています。通信回復後に保存状況を確認してください。";
  }
  const message = error instanceof Error ? error.message : "";
  if (/failed to fetch|fetch failed|load failed|networkerror|network request failed|connection.*(?:closed|lost)|failed to find server action/i.test(message)) {
    return "通信できず、保存結果を確認できません。入力内容は保持しています。通信回復後に、別の画面で保存状況を確認してください。";
  }
  return message || fallback;
}
