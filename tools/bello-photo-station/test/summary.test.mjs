import test from "node:test";
import assert from "node:assert/strict";
import { formatSummary } from "../src/summary.mjs";

test("完了時は仕様どおりの表示文言になる", () => {
  const text = formatSummary({ status: "COMPLETE", uploaded: [1, 2, 3, 4, 5, 6], editFailures: [], uploadFailures: [] }, { photoCount: 6 });
  assert.equal(
    text,
    "写真6枚の編集と検証環境へのアップロードが完了しました。\nBELLO画像登録画面から商品との紐付けを行えます。\nSDカードを取り外せます。",
  );
});

test("一部失敗時は失敗件数とファイル名、再実行可能である旨を伝える", () => {
  const text = formatSummary(
    {
      status: "PARTIAL",
      uploaded: [1, 2],
      editFailures: [{ fileName: "c.jpg" }],
      uploadFailures: [],
    },
    { photoCount: 3 },
  );
  assert.match(text, /3枚中2枚/);
  assert.match(text, /1枚が失敗/);
  assert.match(text, /c\.jpg/);
  assert.match(text, /再実行できます/);
});
