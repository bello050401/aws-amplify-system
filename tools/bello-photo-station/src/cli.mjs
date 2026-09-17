#!/usr/bin/env node
/**
 * 取込済みセッション1件を「設定読込 → 一括編集 → 検証環境へアップロード →
 * 履歴保存」まで通しで実行するCLI。Windowsデスクトップ側(PhotoStation.Desktop)
 * から `node cli.mjs ...` としてサブプロセス起動される想定。
 *
 * このファイル自体はI/O配線(引数解析・環境変数・ファイル列挙)だけを行い、
 * 実処理は settings.mjs / processImage.mjs / history.mjs / runPipeline.mjs /
 * client.mjs / summary.mjs (いずれもテスト済み)に委譲する。
 *
 * 認証トークンは環境変数からのみ受け取り、引数・ログ・標準出力には出さない。
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { SettingsStore } from "./settings.mjs";
import { ProcessingHistoryStore } from "./history.mjs";
import { PhotoRegistrationApiClient } from "./client.mjs";
import { runEditAndUploadPipeline } from "./runPipeline.mjs";
import { formatSummary } from "./summary.mjs";

const SOURCE_EXTENSIONS = new Set([".jpg", ".jpeg"]);

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

async function collectSources(sourceDir) {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry, index) => ({
      clientAssetId: `${index + 1}`.padStart(3, "0"),
      fileName: entry.name,
      sourcePath: path.join(sourceDir, entry.name),
    }));
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const required = ["session-id", "source-dir", "output-root", "settings-file", "history-file", "device-id", "api-endpoint"];
  const missing = required.filter((key) => !args[key]);
  if (missing.length > 0) throw new Error(`Missing required arguments: ${missing.map((m) => `--${m}`).join(", ")}`);

  const token = process.env.BELLO_PHOTO_STATION_TOKEN;
  if (!token) throw new Error("BELLO_PHOTO_STATION_TOKEN environment variable is required");

  const settingsStore = new SettingsStore(args["settings-file"]);
  const { active: settings } = await settingsStore.load();
  const history = new ProcessingHistoryStore(args["history-file"]);
  const api = new PhotoRegistrationApiClient({ endpoint: args["api-endpoint"], tokenProvider: async () => token });
  const sources = await collectSources(args["source-dir"]);

  if (sources.length === 0) {
    console.log("新しい画像候補はありません。");
    return { status: "NO_ASSETS" };
  }

  const result = await runEditAndUploadPipeline({
    sessionId: args["session-id"],
    sources,
    settings,
    outputRoot: args["output-root"],
    history,
    api,
    deviceId: args["device-id"],
    sdCardId: args["sd-card-id"] ?? null,
    onStatus: (stage) => console.log(stage),
  });

  console.log(formatSummary(result, { photoCount: sources.length }));
  return result;
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`;
if (isDirectRun) {
  main()
    .then((result) => {
      // Windowsデスクトップ側のサブプロセス呼び出しが、人間向けのstatus行と
      // 機械可読な結果を区別できるよう、最終行にだけ `RESULT_JSON:` 接頭辞を付ける。
      console.log(`RESULT_JSON:${JSON.stringify(result)}`);
      if (result.status === "FAILED" || result.status === "PARTIAL") process.exitCode = 1;
    })
    .catch((error) => {
      console.error("取込を完了できませんでした：" + error.message);
      process.exitCode = 1;
    });
}
