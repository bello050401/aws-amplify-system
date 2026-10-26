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
import path from "node:path";
import {archiveOriginalSources} from "./originalArchive.mjs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isMainModule } from './isMainModule.mjs';
import { SettingsStore } from "./settings.mjs";
import { ProcessingHistoryStore } from "./history.mjs";
import { PhotoRegistrationApiClient } from "./client.mjs";
import {windowsDeviceProof} from './deviceProof.mjs';
import { runEditAndUploadPipeline } from "./runPipeline.mjs";
import { formatSummary } from "./summary.mjs";
import { collectSources as collectAllSources, validateSelections } from './presetWorkflow.mjs';
import { recordSuccessfulEdit } from './retention.mjs';
import { validateValidationToken } from './validationLogin.mjs';


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

export function isUsableValidationToken(token, nowMs = Date.now()) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.iss === 'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_bKfdql8QT'
      && Array.isArray(payload['cognito:groups']) && payload['cognito:groups'].includes('PHOTO_DEVICE')
      && Number.isFinite(payload.exp) && payload.exp * 1000 > nowMs + 120000;
  } catch { return false; }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const destination = args.destination ?? 'web';
  if (!['web', 'pc', 'shared'].includes(destination)) throw new Error('保存先の種類が不正です');
  const required = ["session-id", "source-dir", "output-root", "settings-file", "history-file",
    ...(destination === 'web' ? ['device-id', 'api-endpoint'] : ['export-directory'])];
  const missing = required.filter((key) => !args[key]);
  if (missing.length > 0) throw new Error(`Missing required arguments: ${missing.map((m) => `--${m}`).join(", ")}`);

  const token = process.env.BELLO_PHOTO_STATION_TOKEN;
  if (destination === 'web' && !token) throw new Error("BELLO_PHOTO_STATION_TOKEN environment variable is required");

  const settingsStore = new SettingsStore(args["settings-file"]);
  const { active: settings } = await settingsStore.load();
  const history = new ProcessingHistoryStore(args["history-file"]);
  const deviceProofProvider=process.env.BELLO_PHOTO_DEVICE_APPROVAL==='enforced'?windowsDeviceProof:undefined;
  const api = destination === 'web' ? new PhotoRegistrationApiClient({ endpoint: args["api-endpoint"], tokenProvider: async () => token,deviceProofProvider }) : null;
  if(api&&deviceProofProvider){const registered=await api.call('registerDevice',{name:args['device-id']});if(registered.pending)throw Error(`PhotoStationの端末承認待ちです。申請番号 ${registered.verificationCode} を管理者に伝えてください。`);args['device-id']=registered.deviceId;}
  const sources = await collectAllSources(args["source-dir"]);
  if(args['archive-only']==='true'){
    if(destination!=='web'||!validateValidationToken(token)||args['api-endpoint'].replace(/\/$/,'')!=='https://dq30ujzf5d.execute-api.us-west-2.amazonaws.com')throw Error('取込写真の送信先・ログインを確認してください。');
    return archiveOriginalSources({api,sessionId:args['session-id'],deviceId:args['device-id'],sources,outputRoot:args['output-root'],onStatus:message=>console.log(message)});
  }
  let framingTopFileName = null;
  let confirmedFramingHash = null;
  let framingOverrides = {};
  try {
    const framing = JSON.parse(await readFile(path.join(args['output-root'], 'framing-choice.json'), 'utf8'));
    framingTopFileName = framing.topFileName;
    confirmedFramingHash = framing.confirmedPlanHash ?? null;
    if (typeof framingTopFileName !== 'string' || !framingTopFileName) throw new Error('トップ画像の選択が不正です');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // The desktop flow requires a product top image. The safe framing plan is
  // calculated during processing and accepted automatically; uncertain plans
  // still stop before any upload.
  if (args['require-selection'] === 'true' && !framingTopFileName)
    throw new Error('商品トップ画像を選んでから保存してください');
  if (destination === 'web' && args['require-selection'] === 'true' && args['api-endpoint'].replace(/\/$/, '') !== 'https://dq30ujzf5d.execute-api.us-west-2.amazonaws.com')
    throw new Error('検証専用API以外へは写真を送信しません');
  if (destination === 'web' && args['require-selection'] === 'true' && !validateValidationToken(token))
    throw new Error('検証用端末の認証が失効しています。写真は送信しません');
  const selectedPresets = args['require-selection'] === 'true'
    ? await validateSelections({ root: path.dirname(args['settings-file']), sessionRoot: args['output-root'], sources, settings })
    : null;
  try { framingOverrides = JSON.parse(await readFile(path.join(args['output-root'], 'framing-overrides.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  if (sources.length === 0) {
    console.log("新しい画像候補はありません。");
    return { status: "NO_ASSETS" };
  }

  const result = await runEditAndUploadPipeline({
    sessionId: args["session-id"],
    sources,
    settings,
    selectedPresets,
    framingTopFileName,
    confirmedFramingHash,
    framingOverrides,
    stationRoot: path.dirname(args['settings-file']),
    outputRoot: args["output-root"],
    history,
    api,
    deviceId: args["device-id"],
    destination,
    exportDirectory: args['export-directory'],
    sdCardId: args["sd-card-id"] ?? null,
    onStatus: (stage) => console.log(stage),
  });

  if (result.status === "COMPLETE" || result.status === 'SAVED_LOCAL') {
    // A retry with the same source/preset must not silently extend the
    // seven-day retention period. Only a different successfully uploaded
    // edit fingerprint does that. Metadata failure is safe (no deletion),
    // so keep the successful upload result and report the warning.
    try {
      const entries = await history.listSession(args["session-id"]);
      const fingerprint = createHash("sha256").update(JSON.stringify(
        sources.map((source) => [source.clientAssetId, entries[source.clientAssetId]?.sourceHash, entries[source.clientAssetId]?.settingsHash]),
      )).digest("hex");
      await recordSuccessfulEdit(path.dirname(args["settings-file"]), args["session-id"], fingerprint);
    } catch (error) {
      console.error("再編集用原本の保存期限を記録できませんでした（原本は削除しません）：" + error.message);
    }
  }

  console.log(formatSummary(result, { photoCount: sources.length }));
  return result;
}

const isDirectRun = isMainModule(import.meta.url);
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
