import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_SETTINGS, SettingsStore, settingsHash } from "../src/settings.mjs";

async function storeInTempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "bello-photo-settings-"));
  return new SettingsStore(path.join(dir, "settings.json"));
}

test("初期編集設定は仕様どおりの値を持つ", () => {
  assert.equal(DEFAULT_SETTINGS.keepAspectRatio, true);
  assert.equal(DEFAULT_SETTINGS.autoCrop, false);
  assert.equal(DEFAULT_SETTINGS.autoRotate, true);
  assert.equal(DEFAULT_SETTINGS.colorSpace, "srgb");
  assert.equal(DEFAULT_SETTINGS.outputFormat, "jpeg");
  assert.equal(DEFAULT_SETTINGS.longEdgePx, 3000);
  assert.equal(DEFAULT_SETTINGS.jpegQuality, 90);
  assert.equal(DEFAULT_SETTINGS.thumbnailLongEdgePx, 480);
  assert.equal(DEFAULT_SETTINGS.thumbnailJpegQuality, 80);
  assert.equal(DEFAULT_SETTINGS.stripMetadata, true);
});

test("未初期化時は既定設定を返す(端末に設定ファイルがまだ無い状態)", async () => {
  const store = await storeInTempDir();
  const state = await store.load();
  assert.deepEqual(state.active, DEFAULT_SETTINGS);
  assert.deepEqual(state.presets, {});
});

test("設定を保存すると再読込後も保持される(再起動を想定した永続化)", async () => {
  const store = await storeInTempDir();
  await store.setActive({ ...DEFAULT_SETTINGS, jpegQuality: 75, longEdgePx: 2400 });
  const reloaded = await store.load();
  assert.equal(reloaded.active.jpegQuality, 75);
  assert.equal(reloaded.active.longEdgePx, 2400);
});

test("初期設定への復元ができる", async () => {
  const store = await storeInTempDir();
  await store.setActive({ ...DEFAULT_SETTINGS, jpegQuality: 40 });
  const restored = await store.resetToDefault();
  assert.deepEqual(restored, DEFAULT_SETTINGS);
});

test("名前を付けたプリセットを複数保存し、切り替えて使用できる", async () => {
  const store = await storeInTempDir();
  await store.savePreset("暗め商品用", { ...DEFAULT_SETTINGS, brightness: -10 });
  await store.savePreset("鮮やか用", { ...DEFAULT_SETTINGS, saturation: 20 });
  const names = await store.listPresetNames();
  assert.deepEqual(names.sort(), ["暗め商品用", "鮮やか用"]);

  const applied = await store.applyPreset("鮮やか用");
  assert.equal(applied.saturation, 20);
  const state = await store.load();
  assert.equal(state.active.saturation, 20);
});

test("存在しないプリセットの適用はエラーになる", async () => {
  const store = await storeInTempDir();
  await assert.rejects(store.applyPreset("no-such-preset"));
});

test("settingsHashは同じ内容なら同じ値、異なれば異なる値になる(再処理判定の基礎)", () => {
  const a = settingsHash(DEFAULT_SETTINGS);
  const b = settingsHash({ ...DEFAULT_SETTINGS });
  const c = settingsHash({ ...DEFAULT_SETTINGS, jpegQuality: 91 });
  assert.equal(a, b);
  assert.notEqual(a, c);
});
