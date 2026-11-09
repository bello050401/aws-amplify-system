export function inventoryEditErrorMessage(cause: unknown, fallback: string): string {
  if (!(cause instanceof Error)) return fallback;
  if (/Server Action.*not found|Failed to find Server Action|failed-to-find-server-action/i.test(cause.message)) {
    return '画面の新しい版が公開されています。入力内容はこの画面に残っています。必要な内容を控えてから再読み込みしてください。適用中だった操作は「前回の操作結果」で確認できます。';
  }
  // Validation messages are Japanese; framework diagnostics are not useful to staff.
  return /[ぁ-んァ-ヶ一-龠]/.test(cause.message) ? cause.message : fallback;
}
