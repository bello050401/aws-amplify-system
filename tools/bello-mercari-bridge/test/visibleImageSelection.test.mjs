import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";
import vm from "node:vm";
import { selectPinnedImageFromVisibleBox, readExactPendingPreview,
  waitForVisibleImageSelection } from "../src/visibleImageSelection.mjs";

const editUrl = "https://mercari-shops.com/seller/shops/shop/products/product/edit";
const remotePath = "/product-image/original.jpg";
const originalHash = createHash("sha256").update(remotePath).digest("hex");
const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const selectedHash = createHash("sha256").update(bytes).digest("hex");
const remote = { currentSrc: `https://images.example${remotePath}?signed=redacted`,
  complete: true, naturalWidth: 960, naturalHeight: 960 };
const data = { currentSrc: `data:image/jpeg;base64,${bytes.toString("base64")}`,
  complete: true, naturalWidth: 1080, naturalHeight: 1080 };

function imagePage(slots) {
  class HTMLImageElement {}
  const images = slots.map(slot => Object.assign(new HTMLImageElement(), slot));
  return { url: () => editUrl, locator: selector => {
    assert.equal(selector, 'img[alt="uploaded-image"]');
    return { evaluateAll: async (callback, expected) => {
      const isolated = vm.runInNewContext(`(${callback.toString()})`, {
        document: { location: { href: editUrl } }, HTMLImageElement,
        crypto: webcrypto, TextEncoder, Uint8Array, URL, atob,
      });
      return isolated(images, expected);
    } };
  } };
}

test("visible image tile opens the chooser and selects pinned bytes once", async () => {
  const actions = [];
  let releaseChooser;
  const page = { url: () => editUrl,
    getByTestId: name => {
      assert.equal(name, "image_box");
      return { count: async () => 2, first: () => ({
        isVisible: async () => true,
        locator: selector => {
          assert.equal(selector, 'img[alt="uploaded-image"]');
          return { count: async () => 0 };
        },
        click: async () => { actions.push("click-visible-box");
          releaseChooser({ isMultiple: () => true, setFiles: async file => {
            assert.equal(file.name, "B005999-test.jpg");
            assert.deepEqual(file.buffer, bytes);
            actions.push("select-pinned-bytes");
          } }); },
      }) };
    },
    waitForEvent: event => {
      assert.equal(event, "filechooser");
      actions.push("await-chooser");
      return new Promise(resolve => { releaseChooser = resolve; });
    },
  };
  await selectPinnedImageFromVisibleBox(page, editUrl,
    { filename: "B005999-test.jpg", mimeType: "image/jpeg" }, bytes);
  assert.deepEqual(actions, ["await-chooser", "click-visible-box", "select-pinned-bytes"]);
});

test("a matching data preview is distinct from a persisted remote second image", async () => {
  const page = imagePage([remote, data]);
  assert.equal(await readExactPendingPreview(page, editUrl, originalHash, selectedHash), true);
  assert.equal(await readExactPendingPreview(page, editUrl, originalHash,
    "f".repeat(64)), false);
  assert.equal(await readExactPendingPreview(imagePage([remote, remote]), editUrl,
    originalHash, selectedHash), false);
  assert.equal(await readExactPendingPreview(imagePage([remote,
    { ...data, complete: false }]), editUrl, originalHash, selectedHash), false);
  const outcome = await waitForVisibleImageSelection(page, editUrl, originalHash,
    selectedHash, async () => null, readExactPendingPreview, 1000);
  assert.deepEqual(outcome, { kind: "PENDING_PREVIEW_MATCHED" });
});
