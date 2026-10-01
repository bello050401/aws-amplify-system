import assert from "node:assert/strict";
import { draftSaveFailureMessage, requireSavedDraftResult } from "../lib/listing/draftSaveFeedback";

const unknown = "下書きの保存結果を確認できませんでした。画面を再読込して状態を確認してください。";
for (const value of [undefined, null, {}, { id: 1 }, { id: "" }, { id: "   " }]) {
  assert.throws(() => requireSavedDraftResult(value), { message: unknown });
}
const saved = { id: "draft-id" };
assert.equal(requireSavedDraftResult(saved), saved);
assert.equal(draftSaveFailureMessage(false, new Error(unknown)), unknown);
assert.equal(draftSaveFailureMessage(true, new Error("photo failed")),
  "下書きは保存されましたが、撮影画像の選択情報の更新に失敗しました: photo failed");
console.log("Listing draft save feedback: PASS");
