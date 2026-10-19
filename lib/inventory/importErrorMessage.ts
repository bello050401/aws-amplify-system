export const IMPORT_OUTCOME_UNCERTAIN =
  "インポート結果を確認できません。二重登録を防ぐため再実行を止めています。通信回復後に在庫一覧を確認してください。入力した列の対応は保持しています。";

export function inventoryImportReadErrorMessage(error: unknown, stage: "file" | "preview"): string {
  const message = error instanceof Error ? error.message : "";
  if (/failed to fetch|fetch failed|load failed|networkerror|network request failed|connection.*(?:closed|lost)|failed to find server action/i.test(message)) {
    return stage === "file"
      ? "通信できませんでした。通信状態を確認し、もう一度ファイルを選択してください。在庫の登録・更新は行っていません。"
      : "通信できませんでした。列の対応は保持しています。通信回復後に「内容を確認する」を押してください。在庫の登録・更新は行っていません。";
  }
  return message || (stage === "file" ? "ファイルの解析に失敗しました。" : "内容確認に失敗しました。");
}
