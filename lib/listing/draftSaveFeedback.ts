import type { ListingDraftRecord } from "./types";

/** A deployment boundary can yield an empty Server Action response. Keep the save result unknown. */
export function requireSavedDraftResult(value: unknown): ListingDraftRecord {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof (value as { id?: unknown }).id !== "string" ||
      !(value as { id: string }).id.trim()) {
    throw new Error("下書きの保存結果を確認できませんでした。画面を再読込して状態を確認してください。");
  }
  return value as ListingDraftRecord;
}

export function draftSaveFailureMessage(draftPersisted: boolean, error: unknown): string {
  const message = error instanceof Error ? error.message : "予期しないエラーが発生しました。";
  return draftPersisted ? `下書きは保存されましたが、撮影画像の選択情報の更新に失敗しました: ${message}` : message;
}
