import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { main, resolveSettings } from "../src/previewCli.mjs";
import { DEFAULT_SETTINGS } from "../src/settings.mjs";
import { makeSyntheticSourceJpeg } from "./testFixtures.mjs";

test("resolveSettings: 引数が無ければ初期設定を使う", async () => {
  const settings = await resolveSettings({});
  assert.deepEqual(settings, DEFAULT_SETTINGS);
});

test("resolveSettings: --settings-jsonは未保存の編集中設定をそのままプレビューに使える(--settings-fileより優先)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bello-preview-settings-"));
  const settingsFile = path.join(dir, "settings.json");
  await writeFile(settingsFile, JSON.stringify({ active: { ...DEFAULT_SETTINGS, jpegQuality: 40 } }));
  const settings = await resolveSettings({
    "settings-file": settingsFile,
    "settings-json": JSON.stringify({ ...DEFAULT_SETTINGS, jpegQuality: 77 }),
  });
  assert.equal(settings.jpegQuality, 77, "--settings-jsonの値が--settings-fileより優先される");
});

test("resolveSettings: --settings-fileだけならそのファイルの保存済み設定を使う", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bello-preview-settings-file-"));
  const settingsFile = path.join(dir, "settings.json");
  await writeFile(settingsFile, JSON.stringify({ active: { ...DEFAULT_SETTINGS, brightness: 15 } }));
  const settings = await resolveSettings({ "settings-file": settingsFile });
  assert.equal(settings.brightness, 15);
});

test("必須引数(--source, --output-dir)が無ければ明示的に失敗する", async () => {
  await assert.rejects(main(["--source", "x.jpg"]), /output-dir/);
});

test("1枚の画像をプレビュー用processed/thumbnailへ書き出し、原本パスも返す(適用前後比較の材料)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bello-preview-run-"));
  const sourcePath = path.join(dir, "source.jpg");
  await writeFile(sourcePath, await makeSyntheticSourceJpeg({ width: 200, height: 100 }));
  const outputDir = path.join(dir, "preview-out");

  const result = await main([
    "--source", sourcePath,
    "--output-dir", outputDir,
    "--settings-json", JSON.stringify({ ...DEFAULT_SETTINGS, longEdgePx: 100, thumbnailLongEdgePx: 40 }),
  ]);

  assert.equal(result.sourcePath, path.resolve(sourcePath), "適用前(原本)と適用後を並べて比較できるよう、原本パスをそのまま返す");
  assert.equal(Math.max(result.processed.width, result.processed.height), 100);
  assert.equal(Math.max(result.thumbnail.width, result.thumbnail.height), 40);
});
