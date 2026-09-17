#!/usr/bin/env node
/**
 * 設定画面の「テスト画像1枚によるプレビュー」「適用前後の比較」用CLI。
 * 指定した1枚の画像へ設定を適用し、processed/thumbnailを書き出すだけの
 * 使い捨て処理。取込セッション・history・アップロードには一切触れない
 * (settings.mjs/processImage.mjsへ委譲するだけ)。原本は読み取り専用。
 *
 * Windowsデスクトップ側(設定画面)から
 * `node previewCli.mjs --source <path> --output-dir <dir> [--settings-file <path> | --settings-json <json>]`
 * としてサブプロセス起動される想定。--settings-jsonを渡すと、画面上で
 * まだ保存していない編集中の設定でプレビューできる(--settings-fileより優先)。
 */
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { SettingsStore, DEFAULT_SETTINGS } from "./settings.mjs";
import { processImage } from "./processImage.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    args[key] = value;
  }
  return args;
}

export async function resolveSettings(args) {
  if (args["settings-json"]) return { ...DEFAULT_SETTINGS, ...JSON.parse(args["settings-json"]) };
  if (args["settings-file"]) return (await new SettingsStore(args["settings-file"]).load()).active;
  return { ...DEFAULT_SETTINGS };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const missing = ["source", "output-dir"].filter((key) => !args[key]);
  if (missing.length > 0) throw new Error(`Missing required arguments: ${missing.map((m) => `--${m}`).join(", ")}`);

  const settings = await resolveSettings(args);
  await mkdir(args["output-dir"], { recursive: true });
  const processedPath = path.join(args["output-dir"], "preview-processed.jpg");
  const thumbnailPath = path.join(args["output-dir"], "preview-thumbnail.jpg");
  const result = await processImage({ sourcePath: args.source, processedPath, thumbnailPath, settings });
  return { sourcePath: path.resolve(args.source), processed: result.processed, thumbnail: result.thumbnail };
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`;
if (isDirectRun) {
  main()
    .then((result) => console.log(`RESULT_JSON:${JSON.stringify(result)}`))
    .catch((error) => {
      console.error("プレビューを生成できませんでした：" + error.message);
      process.exitCode = 1;
    });
}
