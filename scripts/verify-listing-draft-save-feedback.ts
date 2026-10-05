import assert from "node:assert/strict";
import { draftSaveFailureMessage, draftSaveNeedsFreshPage,
  requireSavedDraftResult } from "../lib/listing/draftSaveFeedback";

const unknown = "下書きの保存結果を確認できませんでした。入力を残したまま、最新版を別タブで開いて保存状態を確認してください。";
for (const value of [undefined, null, {}, { id: 1 }, { id: "" }, { id: "   " }]) {
  assert.throws(() => requireSavedDraftResult(value), { message: unknown });
  try { requireSavedDraftResult(value); }
  catch (error) { assert.equal(draftSaveNeedsFreshPage(error), true); }
}
const saved = { id: "draft-id" };
assert.equal(requireSavedDraftResult(saved), saved);
assert.equal(draftSaveFailureMessage(false, new Error(unknown)), unknown);
const stale = new Error('Failed to find Server Action "old-action-id"');
assert.equal(draftSaveNeedsFreshPage(stale), true);
assert.equal(draftSaveFailureMessage(false, stale), unknown);
assert.equal(draftSaveNeedsFreshPage(new Error("出品タイトルを入力してください。")), false);
assert.equal(draftSaveFailureMessage(true, new Error("photo failed")),
  "下書きは保存されましたが、撮影画像の選択情報の更新に失敗しました: photo failed");
console.log("Listing draft save feedback: PASS");
