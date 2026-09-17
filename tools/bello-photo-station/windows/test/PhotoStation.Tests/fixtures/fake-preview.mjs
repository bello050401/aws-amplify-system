#!/usr/bin/env node
// PhotoStation.Tests専用のスタブ。本物のprevidwCli.mjsとは独立に、C#側
// (NodePreviewRunner)の引数配線・RESULT_JSON:解析をsharp等の外部依存なしで
// 検証できるようにする。
const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const source = arg("source");
const outputDir = arg("output-dir");
const settingsJson = arg("settings-json");
if (!source || !outputDir) {
  console.error("missing required arguments");
  process.exitCode = 1;
} else {
  const settings = settingsJson ? JSON.parse(settingsJson) : {};
  const longEdge = settings.longEdgePx ?? 3000;
  const thumbEdge = settings.thumbnailLongEdgePx ?? 480;
  const result = {
    sourcePath: source,
    processed: { path: `${outputDir}/preview-processed.jpg`, width: longEdge, height: Math.round(longEdge / 2) },
    thumbnail: { path: `${outputDir}/preview-thumbnail.jpg`, width: thumbEdge, height: Math.round(thumbEdge / 2) },
  };
  console.log(`RESULT_JSON:${JSON.stringify(result)}`);
}
