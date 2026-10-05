import type { ListingDraftRecord } from "./types";

const UNKNOWN_SAVE_MESSAGE =
  "下書きの保存結果を確認できませんでした。入力を残したまま、最新版を別タブで開いて保存状態を確認してください。";

class UnknownDraftSaveResult extends Error {
  constructor() { super(UNKNOWN_SAVE_MESSAGE); }
}

/** A deployment boundary can yield an empty Server Action response. Keep the save result unknown. */
export function requireSavedDraftResult(value: unknown): ListingDraftRecord {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof (value as { id?: unknown }).id !== "string" ||
      !(value as { id: string }).id.trim()) {
    throw new UnknownDraftSaveResult();
  }
  return value as ListingDraftRecord;
}

/** The old tab must retain its inputs until a fresh deployment is opened separately. */
export function draftSaveNeedsFreshPage(error: unknown): boolean {
  return error instanceof UnknownDraftSaveResult ||
    error instanceof Error &&
      /Failed to find Server Action|Server Action .* was not found|fetch failed|failed to fetch|^Connection closed\.$/i.test(error.message);
}

export function draftSaveFailureMessage(draftPersisted: boolean, error: unknown): string {
  const message = !draftPersisted && draftSaveNeedsFreshPage(error) ? UNKNOWN_SAVE_MESSAGE :
    error instanceof Error ? error.message : "予期しないエラーが発生しました。";
  return draftPersisted ? `下書きは保存されましたが、撮影画像の選択情報の更新に失敗しました: ${message}` : message;
}
