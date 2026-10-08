import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openBelloAdminContext, validBelloOrigin } from "./belloSession.mjs";
import { openDedicatedLogin, openDedicatedProductListSession,
  openExistingProductReadSession } from "./session.mjs";
import { BridgeBoundaryError, reportPinnedDirectReadProofOnce,
  reportSavedReadResultOnce, runBelloCloudReadOnce } from "./cloudConnector.mjs";
import { safeShopsTrafficSummary } from "./trafficObservation.mjs";
import { safeReadQueryCandidates } from "./readQueryObservation.mjs";
import { latestReadTrafficEvidence } from "./trafficEvidence.mjs";
import { assertPinnedDirectReadTarget, directReadProbeAvailable, readDirectReadProbeOutcome,
  runPinnedDirectReadProbeOnce } from "./directReadProbe.mjs";
import { savedDirectReadProofRecord } from "./exportDirectReadProof.mjs";
import { safeReadDiagnostics } from "./readDiagnostics.mjs";
import { observeManualShopsMutation, safeManualMutationSummary } from "./manualMutationObservation.mjs";
import { saveExistingPrivateOnce } from "./saveExistingPrivateOnce.mjs";
import { readManualSaveClaim, readManualSaveOutcome } from "./manualSaveAttempt.mjs";
import { observeBoundedShopsWrite, safeWriteContractSummary } from
  "./writeContractObservation.mjs";
import { CREATE_TEST_TARGET, claimCreateTestOnce, readCreateTestPreflight,
  readCreateTestObservation,
  recordCreateTestObservation } from "./createTestAttempt.mjs";
import { addExistingImageOnce, readRetainedImageState } from "./addExistingImageOnce.mjs";
import { readManualImageClaim, readManualImageOutcome } from "./manualImageAttempt.mjs";
import { runPrivateImageWorkflowOnce } from "./privateImageWorkflow.mjs";
import { inspectPrivateImagePreflight, isPinnedB005757ImageTarget,
  PINNED_B005757_REMOTE_ID } from "./privateImagePreflight.mjs";
import { verifyPrivateImageWorkflowReadOnly } from "./privateImageReadback.mjs";
import { recoverPrivateImageOnce } from "./privateImageRecovery.mjs";
import { readPrivateImageWorkflowClaim, readPrivateImageWorkflowResult } from "./privateImageWorkflowAttempt.mjs";
import { readPrivateImageRecoveryClaim, readPrivateImageRecoveryResult } from
  "./privateImageRecoveryAttempt.mjs";
import { verifyExistingSavedProductReadOnly, readExistingSavedProductReadback } from
  "./existingSavedProductReadback.mjs";
import { enqueueVisibilityPcJob, listVisibilityPcJobs, readVisibilityPcJob } from
  "./visibilityJobInbox.mjs";
import { runVisibilityTransitionOnce } from "./visibilityTransitionOnce.mjs";
import { readShopListingWindow } from "./listingSendGate.mjs";
import { enqueueGeneralPrivateCreate, listGeneralPrivateCreateJobs } from
  "./generalPrivateCreateJob.mjs";
import { readGeneralPrivateCreateRequestJson } from
  "./generalPrivateCreateRequest.mjs";
import { runB005396ReviewedDraft } from
  "./b005396ReviewedDraftRunner.mjs";
import { capturePublicVisibilityProofReadOnly,
  readCurrentPublicVisibilityProof } from "./visibilityPublicProof.mjs";
import { generalPrivateDraftOccupationActive,
  recordGeneralPrivateDraftScreenRecovery } from
  "./generalPrivateDraftOccupancy.mjs";

const HASH = /^[a-f0-9]{64}$/;
const B005396_INVENTORY = "2c53f36a-7a60-4e34-801d-8abc24f6cfc0";
const WORKFLOW_STAGES = new Set(["IMAGE_CLAIMED", "FILE_SELECTION_UNCERTAIN",
  "FILE_SELECTION_RETURNED", "PENDING_PREVIEW_OBSERVED",
  "TWO_IMAGES_VISIBLE", "SAVE_CLAIMED", "NEXT_CLICK_UNCERTAIN",
  "PRIVATE_CLICK_UNCERTAIN", "PRIVATE_CLICK_RETURNED", "SAVE_ACK_UNVERIFIED",
  "READBACK_UNVERIFIED", "PRIVATE_READBACK_CONFIRMED",
  "PRIVATE_TWO_IMAGES_ATTRIBUTION_UNVERIFIED", "AUTH_REQUIRED"]);
const IMAGE_PREFLIGHT_BLOCKS = new Set(["IMAGE_PROOF_UNVERIFIED",
  "NAVIGATION_UNVERIFIED", "FIELDS_UNVERIFIED",
  "ORIGINAL_IMAGE_UNVERIFIED", "PRIVATE_STATE_UNVERIFIED", "RECHECK_UNVERIFIED",
  "FILE_INPUT_UNVERIFIED", "READ_FAILED"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const html = (value) => String(value).replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);
const here = dirname(fileURLToPath(import.meta.url));

function createTestPage({ csrf, message, busy, claim, preflight, result, open, armed }) {
  const button = (action, label, disabled = false) =>
    `<form method="post" action="/action"><input type="hidden" name="csrf" value="${html(csrf)}"><input type="hidden" name="action" value="${action}"><button ${disabled || busy ? "disabled" : ""}>${label}</button></form>`;
  const target = CREATE_TEST_TARGET;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BELLO Shops非公開テスト</title><style>
body{font:16px system-ui,sans-serif;background:#f7f8fa;color:#222;margin:0;padding:24px}main{max-width:680px;margin:auto;background:white;border:1px solid #d5d8de;border-radius:12px;padding:24px}h1{font-size:1.4rem;margin-top:0}section{border-top:1px solid #ddd;padding-top:16px;margin-top:20px}button{background:#0868c7;color:white;border:0;border-radius:6px;padding:12px 18px;font-size:1rem;cursor:pointer}button:disabled{opacity:.45;cursor:default}form{display:inline-block;margin:5px 8px 5px 0}small{color:#555}code{overflow-wrap:anywhere}strong{color:#7a3600}
</style></head><body><main><h1>メルカリShops 非公開テスト登録</h1>
<p>既存の公開商品は変更しません。新しい非公開商品を1件だけ通常画面から登録し、その通信を観測します。このアプリは商品送信ボタンを押しません。</p>
<p><b>対象:</b> ${html(target.expectedName)}<br><b>BELLO管理コード:</b> ${html(target.inventoryCode)}<br><b>新規テスト用コード:</b> ${html(target.skuCode)}<br><b>価格:</b> ${html(target.priceYen.toLocaleString("ja-JP"))}円<br><b>店舗:</b> <code>${html(target.shopId)}</code></p>
<p><small>既存公開商品のID <code>${html(target.existingRemoteId)}</code> は参照だけに使い、上書きしません。画像はBELLOのこの在庫の既存EC画像を使用します。説明・カテゴリ・配送条件は既存商品の確認済み内容を参照して入力してください。公開操作は行いません。</small></p>
<p><small>このテスト用コードは今回のために新しく生成しました。Shops画面では旧コード文字列の出品中検索0件と下書き7件の管理コード不一致を確認しました。ただし検索欄が管理コードを対象にするかは未確認で、Shops内の全商品に同じ管理コードがないことまでは確認していません。</small></p>
${message ? `<p role="status"><strong>${html(message)}</strong></p>` : ""}
<section><h2>1. 専用Shops画面を開く</h2><p>保存済みのPC試行記録を照合し、画面を開く前に今回の一回限りの記録を作ります。結果が不明でも新規作成を繰り返しません。過去の登録試行: ${preflight.clear ? "該当なし" : "あり・要確認"}。</p>
${button("create-test-open", "1回限りの登録準備を開始", claim.claimed || open || !preflight.clear)}
${claim.claimed ? `<p>今回の試行ID: <code>${html(claim.attemptId ?? "記録未確認")}</code>。結果が不明でも再実行しません。</p>` : ""}</section>
<section><h2>2. 最終の非公開保存を観測</h2><p>画像・商品名・テスト用コード・98,000円・説明・カテゴリ・配送設定を通常画面で確認し、「非公開で保存する」を押す直前に観測を開始してください。</p>
${button("create-test-arm", "非公開保存の観測を開始", !open || !claim.valid || armed || Boolean(result))}
${armed ? `<p>観測中です。専用Shops画面で「非公開で保存する」を1回だけ押した後、結果を記録してください。</p>${button("create-test-finish", "送信結果を1回記録")}` : ""}</section>
<section><h2>3. 結果</h2>
${result ? `<p>通常画面の作成応答: <strong>${html(result.outcome)}</strong> / ${html(result.reason)}。</p>${result.newRemoteId ? `<p>今回新たに観測した商品ID: <code>${html(result.newRemoteId)}</code></p>` : ""}<p>非公開・価格・画像は別途読み直して確認します。この結果だけで出品完了や公開を判定しません。結果が不明でも再送しません。</p>` : "<p>まだ送信結果は記録されていません。</p>"}
${button("shutdown", "アプリを終了", open)}</section></main></body></html>`;
}

function optionsOf(config) {
  const localAppData = process.env.LOCALAPPDATA;
  const dataDir = config?.dataDir ?? (localAppData && join(localAppData, "BELLO", "MercariBridge"));
  if (!validBelloOrigin(config?.origin) || !HASH.test(config?.requestId) ||
      !dataDir || !isAbsolute(dataDir)) throw Error("Invalid BELLO desktop configuration");
  const recovery = config?.recovery ?? null;
  if (recovery !== null && (!UUID.test(recovery?.jobId) || !UUID.test(recovery?.attemptId)))
    throw Error("Invalid saved read recovery configuration");
  const manualObservation = config?.manualObservation ?? null;
  const reference = /^[A-Za-z0-9_-]{1,100}$/;
  if (manualObservation !== null &&
      (["shopId", "remoteId", "inventoryCode"].some(key =>
        typeof manualObservation?.[key] !== "string" || !reference.test(manualObservation[key])) ||
       !Number.isSafeInteger(manualObservation?.priceYen) || manualObservation.priceYen < 0 ||
       !Number.isSafeInteger(manualObservation?.quantity) || manualObservation.quantity < 0))
    throw Error("Invalid exact-product observation target");
  if (manualObservation?.remoteId === PINNED_B005757_REMOTE_ID) {
    assertPinnedDirectReadTarget(manualObservation, config.requestId);
    if (manualObservation.skuCode !== CREATE_TEST_TARGET.skuCode ||
        manualObservation.priceYen !== CREATE_TEST_TARGET.priceYen ||
        manualObservation.quantity !== 1)
      throw Error("Invalid B005757 private-image observation target");
  } else if (manualObservation?.skuCode !== undefined &&
             manualObservation.skuCode !== manualObservation.inventoryCode) {
    throw Error("Invalid exact-product observation SKU");
  }
  const directReadTarget = config?.directReadTarget ?? manualObservation;
  if (config?.directReadTarget !== undefined) {
    if (!directReadTarget || Object.keys(directReadTarget).sort().join(",") !==
        "inventoryCode,remoteId,shopId" ||
        manualObservation)
      throw Error("Invalid isolated direct read target");
    assertPinnedDirectReadTarget(directReadTarget, config.requestId);
  }
  const imageProof = config?.imageProof ?? null;
  const imagePrefix = manualObservation && HASH.test(imageProof?.sha256 ?? "") ?
    `${manualObservation.inventoryCode}-${imageProof.sha256.slice(0, 16)}` : null;
  if (imageProof !== null && (!imagePrefix || ![
    join(dataDir, "ImageProof", `${imagePrefix}.jpg`),
    join(dataDir, "ImageProof", `${imagePrefix}.png`),
  ].includes(imageProof.path)))
    throw Error("Invalid pinned local image proof");
  const imageWorkflowEnabled = config?.imageWorkflowEnabled ?? false;
  if (typeof imageWorkflowEnabled !== "boolean" || (imageWorkflowEnabled && !imageProof))
    throw Error("Invalid private-image workflow configuration");
  const createTestObservationEnabled = config?.createTestObservationEnabled ?? false;
  if (typeof createTestObservationEnabled !== "boolean" ||
      Object.hasOwn(config, "createTestSkuAbsentConfirmed") ||
      (createTestObservationEnabled &&
        (manualObservation || directReadTarget || imageProof || recovery || imageWorkflowEnabled)))
    throw Error("The private create test must use its isolated PC configuration");
  const controlPort = config?.controlPort ?? 0;
  if (!Number.isInteger(controlPort) || controlPort < 0 || controlPort > 65535 ||
      (controlPort > 0 && controlPort < 1024))
    throw Error("Invalid local PC control port");
  return { origin: config.origin, requestId: config.requestId, dataDir,
    recovery, manualObservation, directReadTarget, imageProof, imageWorkflowEnabled,
    createTestObservationEnabled, controlPort,
    root: join(dataDir, "Queue"), belloProfileDir: join(dataDir, "BELLOChrome"),
    shopsProfileDir: join(dataDir, "ShopsChrome"),
    playwrightModulePath: join(here, "..", "node_modules", "playwright", "package.json") };
}

function page({ csrf, options, message, busy, workflowRunning, recoveryRunning,
  belloOpen, shopsOpen, manualOpen,
  manualAttempted, lastManual, lastResult, trafficAttempted, lastTraffic, lastReadQueries,
  lastDiagnostics, directProbeAvailable, directProbeState, directProbeReported,
  trafficEvidenceStatus, trafficEvidenceAt,
  privateSaveAttempted, lastPrivateSave, lastPrivateReadback, lastPrivateDiagnostic,
  retainedSaveOpen, imageAttempted, lastImageStatus, lastImageDiagnostic, retainedImageOpen,
  lastImageReadState, workflowAttempted, lastWorkflowStatus, lastWorkflowStage,
  lastImagePreflight, lastWorkflowReadback, lastWorkflowReadbackReason,
  recoveryAttempted, recoveryClaimed,
  lastRecoveryStatus, lastRecoveryStage, recoveryReadbackPrivateWithImage,
  workflowReadbackPrivateWithImage, savedProductReadback,
  retainedWorkflowOpen, createClaim, createPreflight, createResult, createOpen, createArmed,
  visibilityJobs = [], retainedVisibilityOpen = false, generalCreateJobs = [],
  offlineDraftActionEnabled = false, retainedGeneralDraftOpen = false,
  listingWindow = { remainingSeconds: 0, nextAllowedAt: null } }) {
  if (options.createTestObservationEnabled)
    return createTestPage({ csrf, message, busy, claim: createClaim,
      preflight: createPreflight, result: createResult, open: createOpen, armed: createArmed });
  const button = (action, label, disabled = false) =>
    `<form method="post" action="/action"><input type="hidden" name="csrf" value="${html(csrf)}"><input type="hidden" name="action" value="${action}"><button ${disabled || busy || workflowRunning || recoveryRunning || retainedVisibilityOpen || retainedGeneralDraftOpen ? "disabled" : ""}>${label}</button></form>`;
  const visibilityButton = item => {
    const baseDisabled = item.attempted || busy || retainedVisibilityOpen ||
      retainedGeneralDraftOpen ||
      workflowRunning || recoveryRunning ||
      (item.job.action === "STOP" && !item.publicVerified) ||
      item.job.action === "RELIST"; // Public modal controls await read-only observation.
    const waiting = item.job.action === "RELIST" &&
      Number.isInteger(listingWindow.remainingSeconds) &&
      listingWindow.remainingSeconds > 0;
    return `${item.job.action === "STOP" && !item.attempted ? `<form method="post" action="/action"><input type="hidden" name="csrf" value="${html(csrf)}"><input type="hidden" name="action" value="verify-public-visibility"><input type="hidden" name="jobKey" value="${html(item.key)}"><button ${busy || retainedVisibilityOpen || retainedGeneralDraftOpen ? "disabled" : ""}>既存Shops商品の公開状態を読取確認</button></form>` : ""}<form method="post" action="/action"><input type="hidden" name="csrf" value="${html(csrf)}"><input type="hidden" name="action" value="run-visibility-job"><input type="hidden" name="jobKey" value="${html(item.key)}"><button ${item.job.action === "RELIST" ? `data-relist-button data-base-disabled="1"` : ""} ${baseDisabled || waiting ? "disabled" : ""}>${item.job.action === "STOP" ? "出品停止を1回実行" : "出品（同じ商品ID・公開UI確認待ち）"}</button></form>`;
  };
  const pinnedB005757 = isPinnedB005757ImageTarget(options.manualObservation,
    options.requestId);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${workflowRunning || recoveryRunning ? '<meta http-equiv="refresh" content="2">' : ""}<title>BELLO メルカリ照合</title><style>
body{font:16px system-ui,sans-serif;background:#f7f8fa;color:#222;margin:0;padding:24px}main{max-width:640px;margin:auto;background:white;border:1px solid #d5d8de;border-radius:12px;padding:24px}h1{font-size:1.4rem;margin-top:0}section{border-top:1px solid #ddd;padding-top:16px;margin-top:20px}button{background:#0868c7;color:white;border:0;border-radius:6px;padding:12px 18px;font-size:1rem;cursor:pointer}button:disabled{opacity:.45;cursor:default}form{display:inline-block;margin:5px 8px 5px 0}small{color:#555}code{overflow-wrap:anywhere}strong{color:#7a3600}
</style></head><body><main><h1>BELLO メルカリShops既存商品照合</h1>
<p>読取は既存の商品IDを照合します。公開状態の変更は、下のPCジョブを選んだ場合だけ行います。</p>
<p><small>BELLO: ${html(options.origin)}<br>読取依頼ID: <code>${html(options.requestId)}</code></small></p>
${message ? `<p role="status"><strong>${html(message)}</strong></p>` : ""}
${retainedGeneralDraftOpen ? `<section><h2>未解決の非公開下書き画面</h2><p>認証切れまたは結果不明のため、他のPCジョブを停止しています。Shops画面を確認し、このPC上で明示的に回収してください。元の保存操作は再実行できません。</p><form method="post" action="/action"><input type="hidden" name="csrf" value="${html(csrf)}"><input type="hidden" name="action" value="recover-general-draft-session"><button>未解決画面を回収</button></form></section>` : ""}
<section><h2>BELLO EC出品のPCジョブを読み込む</h2><p>BELLOから直接渡せなかった場合だけ、保存したJSONファイルを指定してください。読み込みではShopsを変更しません。</p><form method="post" action="/visibility-import" enctype="multipart/form-data"><input type="hidden" name="csrf" value="${html(csrf)}"><input type="file" name="job" accept=".json,application/json" required><button ${busy || retainedVisibilityOpen || retainedGeneralDraftOpen ? "disabled" : ""}>PCジョブを読み込む</button></form></section>
<section><h2>B005396の出品準備ファイルを読み込む</h2><p>BELLO画面で配送条件を確認して保存したJSONファイルを選んでください。読み込みではShopsへの送信・保存・公開を行いません。</p><form method="post" action="/general-private-create-import" enctype="multipart/form-data"><input type="hidden" name="csrf" value="${html(csrf)}"><input type="file" name="job" accept=".json,application/json" required><button ${busy || retainedVisibilityOpen || retainedGeneralDraftOpen ? "disabled" : ""}>B005396の準備ファイルを読み込む</button></form></section>
${visibilityJobs.length ? `<section><h2>BELLO EC出品からの公開状態ジョブ</h2><p>対象IDと現在の公開状態をShopsで読み直し、1回だけ画面操作します。結果が不明なら再操作しません。再出品はこのPCに同じ商品の停止完了記録がある場合だけ可能です。</p>${visibilityJobs.map(item => `<div><p><strong>${html(item.job.action === "STOP" ? "出品停止" : "再出品")}</strong> / ${html(item.job.target.skuCode)} / 商品ID <code>${html(item.job.target.remoteId)}</code> / ${html(item.attempted ? item.outcome ?? "UNKNOWN" : "未実行")}</p>${visibilityButton(item)}</div>`).join("")}</section>` : ""}
${visibilityJobs.some(item => item.job.action === "RELIST") ? `<p data-listing-countdown data-remaining-seconds="${html(listingWindow.remainingSeconds ?? "")}">${listingWindow.remainingSeconds === null ? "出品間隔の記録を確認できません。再出品はできません。" : listingWindow.remainingSeconds > 0 ? `次の出品まで ${html(listingWindow.remainingSeconds)} 秒` : "出品間隔: 実行可能"}</p><script>/* Display uses a monotonic clock; the PC runner checks the gate again. */
(() => { const label = document.querySelector('[data-listing-countdown]'); const initial = Number(label.dataset.remainingSeconds); if (!Number.isInteger(initial) || initial < 0 || !label.dataset.remainingSeconds) return; const until = performance.now() + initial * 1000; const tick = () => { const seconds = Math.max(0, Math.ceil((until - performance.now()) / 1000)); label.textContent = seconds ? '次の出品まで ' + seconds + ' 秒' : '出品間隔: 実行可能'; document.querySelectorAll('[data-relist-button]').forEach(button => { if (button.dataset.baseDisabled === '0') button.disabled = seconds > 0; }); }; tick(); setInterval(tick, 1000); })();</script>` : ""}
${generalCreateJobs.length ? `<section><h2>BELLOから受け取った新規非公開出品の準備</h2><p>保存された準備内容はShopsへ未送信です。既存商品の重複照合と画像・全項目の照合が完了するまで送信できません。</p>${generalCreateJobs.map(item => `<div><p><code>${html(item.managementCode)}</code> ／ ${html(item.outcome ?? (item.claimed ? "結果の確認が必要" : "未送信"))}</p>${item.inventoryId === B005396_INVENTORY ? `<form method="post" action="/action"><input type="hidden" name="csrf" value="${html(csrf)}"><input type="hidden" name="action" value="run-general-private-draft"><input type="hidden" name="inventoryId" value="${html(item.inventoryId)}"><button ${offlineDraftActionEnabled && !item.claimed && !busy && !retainedGeneralDraftOpen ? "" : "disabled"}>非公開下書きの保存を1回実行</button></form><p><small>${offlineDraftActionEnabled ? "保存前にBELLO、Shopsの重複と画面内容を再確認します。結果不明なら再実行できません。" : "独立レビュー中のため保存操作は保留しています。"}</small></p>` : ""}</div>`).join("")}</section>` : ""}
${retainedVisibilityOpen ? "<p>Shops操作の結果を確認できません。専用Chromeを開いたままにしています。再操作せず状態を確認してください。</p>" : ""}
${workflowRunning ? `<p>工程を実行中です。現在の段階: <code>${html(lastWorkflowStage || "準備中")}</code></p>` : ""}
${recoveryRunning ? `<p>一回限りの復旧工程を実行中です。現在の段階: <code>${html(lastRecoveryStage || "準備中")}</code></p>` : ""}
<section><h2>1. 通常ログイン</h2><p>BELLOとShopsを、それぞれ専用のChromeで開きます。ログインが済んだらブラウザを閉じてください。ログイン情報をコピーしません。</p>
${button("bello-login", belloOpen ? "BELLOログイン画面を開いています" : "BELLOにログイン", belloOpen)}
${button("shops-login", shopsOpen ? "Shopsログイン画面を開いています" : "Shopsにログイン", shopsOpen)}</section>
<section><h2>2. 既存商品を1回照合</h2><p>両方のログイン後に押してください。照合できない項目は未確認のままBELLOへ報告します。</p>
${button("read", "この読取依頼を照合する")}
${options.recovery ? `<p>前回の保存済み読取結果を、Shopsに再アクセスせずBELLOへ報告できます。</p>
${button("retry-report", "前回の結果だけをBELLOへ再報告する")}` : ""}
${lastResult ? `<p>直近の結果: <strong>${html(lastResult)}</strong>。出品完了の確認ではありません。</p>` : ""}
<p><small>通信概要の保存状態: <code>${html(trafficEvidenceStatus)}</code>${trafficEvidenceAt ? `（保存時刻: <time>${html(trafficEvidenceAt)}</time>）` : ""}。旧版のメモリ内だけの観測は再起動後に復元できません。保存済み概要は過去の読取分の場合があります。概要にはHTTP直接通信に必要な契約情報がなく、直接送信には使いません。</small></p>
${trafficAttempted ? `<details><summary>Shops通信の概要（${lastTraffic.length}種類）</summary>
<p><small>固定語彙の概要だけをこのPCに保存します。URLの値・検索条件・認証情報・本文は記録せず、BELLOにも送りません。</small></p>
${lastTraffic.length ? `<ul>${lastTraffic.map(item => `<li><code>${html(item.method)} ${html(item.host)}${html(item.path)}</code> — ${html(item.status)}（${html(item.count)}回）</li>`).join("")}</ul>` : "<p>対象となる通信は観測されませんでした。</p>"}</details>` : ""}</section>
${trafficAttempted ? `<details><summary>読取GraphQL候補（${lastReadQueries.length}件）</summary><p><small>操作名と変数の型、対象IDとの一致結果だけです。認証欄はヘッダーの存在を示すのみで、HTTP直接通信の認証要件や実行許可を証明しません。</small></p>
${lastReadQueries.length ? `<ol>${lastReadQueries.map(item => `<li><code>${html(item.operationName ?? "操作名未確認")}</code> / query SHA-256 ${html(item.querySha256 ?? "未確認")} / 変数 ${item.variableFields.map(field => html(`${field.field}:${field.type}`)).join(", ") || "未確認"} / 変数形状 ${item.variableShapeComplete ? "観測範囲内" : "一部未確認"} / 要求商品ID ${html(item.requestProductMatch)} / 要求店舗ID ${html(item.requestShopMatch)} / 応答商品ID ${html(item.responseProductMatch)} / 応答店舗ID ${html(item.responseShopMatch)} / HTTP ${html(item.httpStatus ?? "未確認")} / GraphQLエラー ${html(item.graphqlErrors)} / 認証ヘッダー存在 ${item.authPresenceObserved ? item.authPresence.authorization ? "あり" : "なし" : "未確認"}、Cookie存在 ${item.authPresenceObserved ? item.authPresence.cookie ? "あり" : "なし" : "未確認"}、CSRF存在 ${item.authPresenceObserved ? item.authPresence.csrf ? "あり" : "なし" : "未確認"}</li>`).join("")}</ol>` : "<p>対象IDに結び付く読取query候補は観測されませんでした。</p>"}</details>` : ""}
${directProbeAvailable || directProbeState.claimed ? `<section><h2>既存商品のHTTP読取を1回検証</h2><p>通常のログイン済み読取で同じqueryと商品IDを確認してから、同じ専用ブラウザの認証状態でHTTP読取を1回だけ行います。商品は変更しません。結果はこのPCに固定コードだけを記録します。</p>
${button("probe-direct-read-once", "既存商品をHTTPで1回読取検証", !directProbeAvailable || directProbeState.claimed)}
${directProbeState.claimed ? `<p>結果: <strong>${html(directProbeState.outcome ?? "未確認")}</strong>${directProbeState.httpStatus ? ` / HTTP ${html(directProbeState.httpStatus)}` : ""}。結果が不明でも再送しません。PC内の認証での検証であり、BELLO Webサーバーからの通信成立を示すものではありません。</p>` : ""}
${directProbeState.outcome === "MATCHED" && directProbeState.httpStatus === 200 ?
  `${button("download-direct-read-proof", "BELLO用の読取記録ファイルを保存")}${button("report-direct-read-proof", "保存済みHTTP読取結果をBELLOへ報告", directProbeReported)}<p><small>ファイルを保存し、ログイン中のBELLO設定画面で読み込めます。Shopsへの読取を再実行しません。BELLOには固定の読取成功コードだけを送ります。出品・書込成功にはしません。</small></p>` : ""}</section>` : ""}
${trafficAttempted ? `<section><h2>読取診断</h2><p><small>このPC画面に一時表示する固定コードです。値やURLは記録せず、BELLOにも送りません。</small></p>
${lastDiagnostics.length ? `<p><code>${lastDiagnostics.map(html).join(" / ")}</code></p>` : "<p>診断コードはありません。照合成功を意味するものではありません。</p>"}</section>` : ""}
${options.manualObservation && !options.imageWorkflowEnabled ? `<section><h2>既存商品の通信観測</h2>
<p>内容を変えず、既存商品 ${html(options.manualObservation.inventoryCode)} を非公開のまま1回保存します。対象ID・価格・数量・非公開を確認できない場合は送信しません。結果が不明でも再送しません。</p>
${button("save-private-once", "既存商品を非公開で1回保存", privateSaveAttempted || manualOpen)}
${privateSaveAttempted ? `<p>この商品の保存操作は実行済み、または結果不明です。再実行はできません。${lastPrivateSave ? `結果: <strong>${html(lastPrivateSave)}</strong>` : ""}</p>` : ""}
${lastPrivateDiagnostic ? `<p><small>停止・観測段階: <code>${html(lastPrivateDiagnostic)}</code></small></p>` : ""}
${lastPrivateReadback ? "<p>保存後の読取で、対象商品の非公開状態と商品コード・価格・数量を確認しました。保存通信の成功判定とは別です。</p>" : ""}
${retainedSaveOpen ? `<p>保存通信を中断しないため、専用Chromeを開いたままにしています。通信概要を更新できます。Shops画面で保存処理が終わったことを確認してからChromeを閉じてください。</p>${button("refresh-save-observation", "保存通信の概要を更新")}` : ""}
<details><summary>手動の通信観測</summary>
<p>対象は ${html(options.manualObservation.inventoryCode)} / ${html(options.manualObservation.remoteId)} です。専用Chromeで価格 ${html(options.manualObservation.priceYen)} 円、数量 ${html(options.manualObservation.quantity)}、非公開を確認してから、人が内容を変えずに非公開保存を1回だけ行います。このアプリは保存を押しません。</p>
${button("observe-start", "観測用の専用Chromeを開く", manualOpen || privateSaveAttempted)}
${manualOpen ? button("observe-stop", "観測を終了して概要を見る") : ""}
${manualAttempted ? `<details><summary>通信観測の概要（${lastManual.length}件）</summary><p><small>このPC画面のメモリ内だけに表示します。本文・認証値・画像データを保存せず、BELLOへ送りません。HTTP成立の判定は別途必要です。</small></p>
${lastManual.length ? `<ol>${lastManual.map(item => `<li><code>${html(item.order)}. ${html(item.method)} ${html(item.host)}${html(item.path)}</code> / ${html(item.bodyType)} / HTTP ${html(item.httpStatus ?? "未確認")} / 認証ヘッダー ${item.auth.authorization ? "あり" : "なし"}、Cookie ${item.auth.cookie ? "あり" : "なし"}、CSRF ${item.auth.csrf ? "あり" : "なし"} / 項目 ${item.fields.map(field => html(`${field.field}:${field.type}`)).join(", ") || "未確認"} / 操作名 ${html(item.operationName ?? "未確認")} / 応答項目 ${html(item.responseField ?? "未確認")} / 応答種別 ${html(item.responseKind ?? "未確認")} / 商品ID一致 ${html(item.productMatch ?? "未確認")} / 店舗ID一致 ${html(item.shopMatch ?? "未確認")} / 状態 ${html(item.state ?? "未確認")} / GraphQLエラー ${html(item.graphqlErrors ?? "未確認")} ${html(item.graphqlErrorClass ?? "")}</li>`).join("")}</ol>` : "<p>対象となる送信は観測されませんでした。</p>"}</details>` : ""}</details></section>` : ""}
${options.imageProof && !options.imageWorkflowEnabled ? `<section><h2>既存商品への画像1枚追加</h2><p>対象画像のハッシュを確認し、既存の非公開商品と画像を照合してから、画像ファイルを1回だけ選択します。ファイル選択で送信が始まる可能性があります。商品保存・公開は押しません。</p>
${button("add-image-once", "既存商品に画像を1枚追加して観測", imageAttempted || manualOpen || retainedSaveOpen || retainedImageOpen)}
${imageAttempted ? `<p>画像選択は試行済み、または結果不明です。再実行できません。結果: <strong>${html(lastImageStatus || "UNKNOWN")}</strong> / 段階: <code>${html(lastImageDiagnostic || "未確認")}</code></p>` : ""}
${retainedImageOpen ? `<p>専用Chromeを開いたままにしています。既存画像が残り、追加画像が表示されたか確認してください。画像選択のみでは商品保存を確認できません。</p>${button("refresh-image-observation", "画像通信の概要を更新")}${button("inspect-retained-image", "開いている商品画面の画像を確認")}` : ""}
${lastImageReadState ? `<p>画面上の画像: <code>${html(lastImageReadState)}</code>。表示の確認であり、商品保存・公開の確認ではありません。</p>` : ""}</section>` : ""}
${options.imageWorkflowEnabled ? `<section><h2>既存商品の画像追加と非公開保存</h2><p>既存商品を照合し、画像1枚の追加、非公開保存、同じ商品の再読込まで1回の操作で確認します。既存の試行がある商品には再実行しません。</p>
${pinnedB005757 ? button("inspect-image-preflight", "画像と非公開状態を読取だけで事前確認", manualOpen || shopsOpen || retainedSaveOpen || retainedImageOpen || retainedWorkflowOpen) : ""}
${pinnedB005757 && lastImagePreflight ? `<p>事前確認: <strong>${html(lastImagePreflight.status)}</strong> / <code>${html(lastImagePreflight.reasonCode)}</code>。画像選択や保存は行っていません。</p>` : ""}
${button("complete-image-private", "画像1枚を追加して非公開保存・確認", workflowAttempted || manualOpen || retainedSaveOpen || retainedImageOpen || retainedWorkflowOpen ||
  (options.manualObservation.remoteId === PINNED_B005757_REMOTE_ID &&
    (!pinnedB005757 || lastImagePreflight?.status !== "READY")))}
${lastWorkflowStatus && !workflowRunning ? `<p>${workflowAttempted ? "この商品の工程は試行済み、または結果不明です。再実行できません。" : "画像選択前の事前確認で停止しました。"} 結果: <strong>${html(lastWorkflowStatus)}</strong> / 段階: <code>${html(lastWorkflowStage || "PRECLAIM")}</code></p>` : ""}
${pinnedB005757 && workflowAttempted && lastWorkflowStatus === "UNKNOWN" &&
  lastWorkflowStage === "FILE_SELECTION_UNCERTAIN" ?
  `<p>画像選択後の結果は不明です。別の読取画面で、この商品の現在の画像枚数と非公開状態だけを確認できます。</p>
  ${button("verify-workflow-readonly", "今回の商品を読取だけで再確認", shopsOpen || manualOpen || retainedSaveOpen || retainedImageOpen || retainedWorkflowOpen)}
  ${lastWorkflowReadback ? `<p>復旧前の読取: <code>${html(lastWorkflowReadback)}</code>${lastWorkflowReadbackReason ? ` / <code>${html(lastWorkflowReadbackReason)}</code>` : ""}。画像資産の同一性や保存要求の成功は証明しません。</p>` : ""}` : ""}
${pinnedB005757 && workflowAttempted && lastWorkflowStatus === "UNKNOWN" &&
  lastWorkflowStage === "FILE_SELECTION_UNCERTAIN" &&
  lastWorkflowReadback === "PRIVATE_ONE_IMAGE_OBSERVED" ?
  `<p>前回の画像資産がShopsに作成されている可能性があります。再試行すると資産が重複する場合があります。商品への画像反映が1枚と確認された場合だけ、同じ商品を非公開のまま一度だけ復旧します。</p>
  ${button("recover-image-once", "確認後に画像追加と非公開保存を1回だけ復旧", recoveryAttempted || shopsOpen || manualOpen || retainedSaveOpen || retainedImageOpen || retainedWorkflowOpen)}` : ""}
${pinnedB005757 && recoveryAttempted ? `<p>${recoveryClaimed ? "復旧工程は試行済み、または結果不明です。再実行できません。" : "復旧前の確認で停止しました。画像は再送していません。"} 結果: <strong>${html(lastRecoveryStatus || "UNKNOWN")}</strong> / 段階: <code>${html(lastRecoveryStage || "PRECLAIM")}</code>。</p>` : ""}
${recoveryReadbackPrivateWithImage ? "<p>別の読取画面で、対象商品が非公開で画像2枚と確認しました。保存通信の成功判定とは別です。</p>" : ""}
${workflowReadbackPrivateWithImage ? "<p>別タブで対象商品を再読込し、非公開と画像2枚を確認しました。保存要求の応答確認とは別の結果です。</p>" : ""}
${retainedWorkflowOpen ? `<p>結果が確定していないため専用Chromeを保持しています。再送せず画面と通信を確認してください。</p>${button("refresh-workflow-observation", "工程の通信概要を更新")}${button("inspect-workflow-image", "保持中画面の画像を読取")}` : ""}
${options.imageWorkflowEnabled && manualAttempted ? `<details><summary>対象Shops通信の概要（${lastManual.length}件）</summary><p><small>保存クリック後の要求候補です。本文・変数値・認証情報は記録しません。要求の一致だけでは保存成功と判定しません。</small></p><ol>${lastManual.map(item => `<li><code>${html(item.order)}. ${html(item.method)} ${html(item.host)}${html(item.path)}</code> / HTTP ${html(item.httpStatus ?? "未確認")} / 操作 ${html(item.operationName ?? "未確認")} / 操作種別 ${html(item.graphqlOperationType ?? "未確認")} / query SHA-256 ${html(item.querySha256 ?? "未確認")} / 変数項目 ${item.fields.map(field => html(`${field.field}:${field.type}`)).join(", ") || "未確認"} / 要求商品ID ${html(item.requestProductMatch ?? "未確認")} / 要求非公開 ${html(item.requestPrivateState ?? "未確認")} / 応答 ${html(item.responseField ?? "未確認")} / 種別 ${html(item.responseKind ?? "未確認")} / 応答商品ID ${html(item.productMatch ?? "未確認")} / 店舗ID ${html(item.shopMatch ?? "未確認")} / 状態 ${html(item.state ?? "未確認")} / GraphQLエラー ${html(item.graphqlErrors ?? "未確認")}</li>`).join("")}</ol></details>` : ""}
${lastImageReadState && retainedWorkflowOpen ? `<p>画面上の画像: <code>${html(lastImageReadState)}</code>。保存確認ではありません。</p>` : ""}</section>` : ""}
${options.manualObservation && options.imageProof ? `<section><h2>保存済み商品の読取確認</h2><p>既存の画像選択・保存の試行記録に対象商品を紐付け、現在の非公開状態と画像2枚を読み直します。画像追加や保存は行いません。</p>
${button("verify-saved-product-readonly", "既存商品を読取で再確認", shopsOpen || manualOpen || retainedSaveOpen || retainedImageOpen || retainedWorkflowOpen)}
${savedProductReadback ? `<p>現在の読取結果: <strong>${html(savedProductReadback.status)}</strong>。画像試行記録: <code>${html(savedProductReadback.imageOutcome)}</code>、保存試行記録: <code>${html(savedProductReadback.saveOutcome)}</code>。現在の表示状態であり、過去の保存要求が成功した証明ではありません。</p>` : ""}</section>` : ""}
<section><h2>3. BELLOで結果を見る</h2><p>照合後、BELLOの照合依頼画面で「照合結果を確認する」を押してください。</p>
<p><a href="${html(options.origin)}/inventory/mercari-bridge?requestId=${html(options.requestId)}" target="_blank" rel="noopener noreferrer">BELLOの照合依頼画面を開く</a></p>
${button("shutdown", "このアプリを終了", retainedSaveOpen || retainedImageOpen || retainedWorkflowOpen)}</section>
</main></body></html>`;
}

const send = (response, status, content, contentType = "text/html; charset=utf-8") => {
  response.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" });
  response.end(content);
};

async function openManualObservationForExisting({ root, profileDir, playwrightModulePath, shopId, remoteId }) {
  const session = await openExistingProductReadSession({ root, profileDir, playwrightModulePath,
    shopId, remoteId });
  if (session.state !== "NAVIGATED_UNVERIFIED") {
    await session.context.close();
    throw Error("Exact existing Shops edit page was not reached");
  }
  const expectedUrl = `https://mercari-shops.com/seller/shops/${shopId}/products/${remoteId}/edit`;
  return { context: session.context, observer: observeManualShopsMutation(session.page, expectedUrl) };
}

/** Visible loopback UI. Every read is a deliberate click bound to one configured request ID. */
export async function startDesktopApp(config, {
  openBello = openBelloAdminContext, openShops = openDedicatedLogin,
  openManualObservation = openManualObservationForExisting,
  runPrivateSave = saveExistingPrivateOnce, runImageAdd = addExistingImageOnce,
  inspectImage = readRetainedImageState,
  runWorkflow = runPrivateImageWorkflowOnce,
  runImagePreflight = inspectPrivateImagePreflight,
  runWorkflowReadback = verifyPrivateImageWorkflowReadOnly,
  runRecovery = recoverPrivateImageOnce,
  runSavedProductReadback = verifyExistingSavedProductReadOnly,
  runDirectReadProbe = runPinnedDirectReadProbeOnce,
  reportDirectRead = reportPinnedDirectReadProofOnce,
  openCreateList = openDedicatedProductListSession,
  observeCreate = observeBoundedShopsWrite,
  claimCreate = claimCreateTestOnce,
  readCreatePreflight = readCreateTestPreflight,
  readCreate = readCreateTestObservation,
  recordCreate = recordCreateTestObservation,
  runRead = runBelloCloudReadOnce, reportRead = reportSavedReadResultOnce, openBrowser = null,
  enqueueVisibility = enqueueVisibilityPcJob,
  runVisibility = runVisibilityTransitionOnce,
  runGeneralDraft = args => runB005396ReviewedDraft(args, {
    mode: "DRY_READ_ONLY" }),
  offlineDraftActionEnabled = false,
  verifyPublicVisibility = capturePublicVisibilityProofReadOnly,
  readPublicVisibility = readCurrentPublicVisibilityProof,
} = {}) {
  const options = optionsOf(config);
  let persistedGeneralDraftHold = await generalPrivateDraftOccupationActive(options.root);
  const initialCreate = options.createTestObservationEnabled ?
    await readCreate(options.root) : null;
  let createClaim = initialCreate?.claim ?? { claimed: false, valid: true,
    attemptId: null, claimedAt: null };
  let createPreflight = options.createTestObservationEnabled ?
    await readCreatePreflight(options.root) : null;
  let createResult = initialCreate?.result ?? null;
  let createSession = null;
  let createArmed = false;
  const workflowClaim = options.manualObservation ?
    await readPrivateImageWorkflowClaim(options.root, options.manualObservation) : null;
  let privateSaveAttempted = Boolean(options.manualObservation &&
    ((await readManualSaveClaim(options.root, options.manualObservation)).claimed ||
      workflowClaim?.claimed));
  const savedPrivateOutcome = options.manualObservation ?
    await readManualSaveOutcome(options.root, options.manualObservation) : null;
  let imageAttempted = Boolean(options.imageProof &&
    ((await readManualImageClaim(options.root, options.manualObservation,
      options.imageProof.sha256)).claimed || workflowClaim?.claimed));
  const savedImageOutcome = options.imageProof ?
    await readManualImageOutcome(options.root, options.manualObservation, options.imageProof.sha256) : null;
  const workflowAttempted = Boolean(options.imageWorkflowEnabled &&
    (workflowClaim.claimed || imageAttempted || privateSaveAttempted));
  const savedWorkflowResult = options.imageWorkflowEnabled ?
    await readPrivateImageWorkflowResult(options.root, options.manualObservation) : null;
  const recoveryClaim = options.imageWorkflowEnabled &&
    isPinnedB005757ImageTarget(options.manualObservation, options.requestId) ?
    await readPrivateImageRecoveryClaim(options.root, options.manualObservation,
      options.requestId) : null;
  const savedRecoveryResult = recoveryClaim?.claimed ?
    await readPrivateImageRecoveryResult(options.root, options.manualObservation,
      options.requestId) : null;
  let savedProductReadback = options.imageProof ?
    await readExistingSavedProductReadback(options.root, options.manualObservation,
      options.imageProof.sha256) : null;
  const csrf = randomBytes(32).toString("hex");
  let busy = false;
  let message = "";
  let lastResult = "";
  const storedTrafficEvidence = await latestReadTrafficEvidence(options.root, options.requestId);
  let trafficAttempted = ["OBSERVED", "EMPTY"].includes(storedTrafficEvidence.status);
  let lastTraffic = storedTrafficEvidence.entries;
  let lastReadQueries = storedTrafficEvidence.readQueries;
  let directProbeAvailable = false;
  let directProbeState = { claimed: false, outcome: null, httpStatus: null };
  let directProbeReported = false;
  if (options.directReadTarget) {
    try {
      directProbeState = await readDirectReadProbeOutcome(options.root, options.directReadTarget);
      directProbeAvailable = await directReadProbeAvailable(options.root, options.requestId,
        options.directReadTarget);
    } catch { /* Other products never expose this pinned proof action. */ }
  }
  let trafficEvidenceStatus = storedTrafficEvidence.status;
  let trafficEvidenceAt = storedTrafficEvidence.observedAt;
  let lastDiagnostics = [];
  let belloContext = null;
  let shopsContext = null;
  let manualSession = null;
  let manualAttempted = Boolean(savedWorkflowResult?.observation?.length);
  let lastManual = safeManualMutationSummary(savedWorkflowResult?.observation ?? []);
  let lastPrivateSave = savedPrivateOutcome?.outcome ?? "";
  let lastPrivateReadback = savedPrivateOutcome?.postflightPrivate === true;
  let lastPrivateDiagnostic = savedPrivateOutcome?.diagnostic ?? "";
  let retainedSaveSession = null;
  let retainedImageSession = null;
  let retainedWorkflowSession = null;
  let retainedVisibilitySession = null;
  let retainedGeneralDraftSession = null;
  let lastImageStatus = savedImageOutcome?.outcome ?? "";
  let lastImageDiagnostic = savedImageOutcome?.diagnostic ?? "";
  let lastImageReadState = "";
  let workflowUsed = workflowAttempted;
  let workflowRunning = false;
  let recoveryRunning = false;
  let lastWorkflowStatus = savedWorkflowResult?.status ?? "";
  let lastWorkflowStage = savedWorkflowResult?.stage ?? "";
  let lastImagePreflight = null;
  let lastWorkflowReadback = "";
  let lastWorkflowReadbackReason = "";
  let recoveryUsed = Boolean(recoveryClaim?.claimed);
  let recoveryClaimed = Boolean(recoveryClaim?.claimed);
  let lastRecoveryStatus = savedRecoveryResult?.status ?? "";
  let lastRecoveryStage = savedRecoveryResult?.stage ?? "";
  let recoveryReadbackPrivateWithImage = savedRecoveryResult?.readbackPrivateWithImage === true;
  let workflowReadbackPrivateWithImage = savedWorkflowResult?.readbackPrivateWithImage === true;
  let finishingCreate = null;
  const finishCreate = (stopped = false, selectedSession = createSession) => {
    if (finishingCreate) return finishingCreate;
    if (!createClaim.claimed || createResult) return Promise.resolve(createResult);
    return finishingCreate = (async () => {
      const summary = selectedSession?.observer ?
        stopped ? selectedSession.observer.stop() : await selectedSession.observer.finish() :
        safeWriteContractSummary({ reason: "STOPPED", expectedKind: "CREATE_PRODUCT" });
      const result = await recordCreate(options.root, createClaim.attemptId, summary);
      createResult = result;
      createArmed = false;
      if (selectedSession) selectedSession.observer = null;
      return result;
    })().finally(() => { finishingCreate = null; });
  };
  let finishingManual = null;
  const finishManual = () => {
    if (finishingManual) return finishingManual;
    if (!manualSession) return Promise.resolve();
    return finishingManual = (async () => {
    try { lastManual = safeManualMutationSummary(await manualSession.observer.stop()); }
    finally { manualSession = null; manualAttempted = true; finishingManual = null; }
    })();
  };
  let localOrigin;
  const server = createServer(async (request, response) => {
    if (request.url === "/listing-send-window" &&
        ["OPTIONS", "GET"].includes(request.method)) {
      if (options.createTestObservationEnabled || request.headers.origin !== options.origin) {
        response.writeHead(403); response.end(); return;
      }
      const headers = { "Access-Control-Allow-Origin": options.origin,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Private-Network": "true", Vary: "Origin",
        "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" };
      if (request.method === "OPTIONS") {
        response.writeHead(204, headers); response.end(); return;
      }
      try {
        const window = await readShopListingWindow(options.root, CREATE_TEST_TARGET.shopId);
        response.writeHead(200, headers);
        response.end(JSON.stringify({ ok: true, ...window }));
      } catch { response.writeHead(503, headers); response.end('{"ok":false}'); }
      return;
    }
    if (request.url?.startsWith("/visibility-status?") &&
        ["OPTIONS", "GET"].includes(request.method)) {
      if (options.createTestObservationEnabled || request.headers.origin !== options.origin) {
        response.writeHead(403); response.end(); return;
      }
      const headers = { "Access-Control-Allow-Origin": options.origin,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Allow-Private-Network": "true", Vary: "Origin",
        "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" };
      if (request.method === "OPTIONS") {
        response.writeHead(204, headers); response.end(); return;
      }
      const inventoryId = new URL(request.url, localOrigin).searchParams.get("inventoryId");
      if (typeof inventoryId !== "string" || !UUID.test(inventoryId)) {
        response.writeHead(400, headers); response.end('{"ok":false}'); return;
      }
      try {
        const jobs = (await listVisibilityPcJobs(options.root))
          .filter(item => item.job.target.inventoryId === inventoryId)
        const items = jobs.map(item => ({ action: item.job.action,
            remoteId: item.job.target.remoteId, attempted: item.attempted,
            outcome: item.outcome }));
        const stop = jobs.find(item => item.job.action === "STOP");
        const proof = stop ? await readPublicVisibility(options.root,
          stop.job.target) : null;
        const publicProof = proof?.status === "PUBLIC_CONFIRMED" &&
          proof.allowStop === true &&
          proof.remoteId === stop?.job.target.remoteId ?
          { remoteId: proof.remoteId, status: "PUBLIC_CONFIRMED",
            observedAt: proof.observedAt } : null;
        response.writeHead(200, headers);
        response.end(JSON.stringify({ ok: true, items, publicProof }));
      } catch { response.writeHead(503, headers); response.end('{"ok":false}'); }
      return;
    }
    if (request.url === "/visibility-job" &&
        ["OPTIONS", "POST"].includes(request.method)) {
      const allowed = !options.createTestObservationEnabled &&
        !persistedGeneralDraftHold && !retainedGeneralDraftSession &&
        request.headers.origin === options.origin;
      const cors = { "Access-Control-Allow-Origin": options.origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, x-bello-mercari-bridge",
        "Access-Control-Allow-Private-Network": "true", Vary: "Origin",
        "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" };
      if (!allowed) { response.writeHead(403); response.end(); return; }
      if (request.method === "OPTIONS") {
        response.writeHead(204, cors); response.end(); return;
      }
      if (request.headers["x-bello-mercari-bridge"] !== "VISIBILITY_JOB" ||
          !request.headers["content-type"]?.startsWith("application/json")) {
        response.writeHead(403, cors); response.end('{"ok":false}'); return;
      }
      let body = "";
      try {
        for await (const chunk of request) {
          body += chunk.toString("utf8");
          if (Buffer.byteLength(body, "utf8") > 8192)
            throw Error("Job body too large");
        }
        const job = JSON.parse(body);
        const queued = await enqueueVisibility(options.root, job);
        response.writeHead(200, cors);
        response.end(JSON.stringify({ ok: true, status: queued.status,
          jobKey: queued.key }));
      } catch {
        response.writeHead(409, cors); response.end('{"ok":false}');
      }
      return;
    }
    if (request.url === "/general-private-create-job" &&
        ["OPTIONS", "POST"].includes(request.method)) {
      const cors = { "Access-Control-Allow-Origin": options.origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, x-bello-mercari-bridge",
        "Access-Control-Allow-Private-Network": "true", Vary: "Origin",
        "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" };
      if (options.createTestObservationEnabled ||
          persistedGeneralDraftHold || retainedGeneralDraftSession ||
          request.headers.origin !== options.origin) {
        response.writeHead(403); response.end(); return;
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204, cors); response.end(); return;
      }
      if (request.headers["x-bello-mercari-bridge"] !==
            "GENERAL_PRIVATE_CREATE_NO_SEND" ||
          !request.headers["content-type"]?.startsWith("application/json")) {
        response.writeHead(403, cors); response.end('{"ok":false}'); return;
      }
      try {
        const body = await readGeneralPrivateCreateRequestJson(request);
        const queued = await enqueueGeneralPrivateCreate(options.root, body);
        response.writeHead(200, cors);
        response.end(JSON.stringify({ ok: true, ...queued }));
      } catch (error) {
        const unknown = error?.message === "GENERAL_PRIVATE_CREATE_UNKNOWN_NO_RETRY";
        response.writeHead(409, cors);
        response.end(JSON.stringify({ ok: false,
          code: unknown ? "UNKNOWN_NO_RETRY" : "PREPARATION_REJECTED" }));
      }
      return;
    }
    if (request.method === "POST" &&
        request.url === "/general-private-create-import") {
      if (options.createTestObservationEnabled ||
          persistedGeneralDraftHold || retainedGeneralDraftSession ||
          request.headers.origin !== localOrigin ||
          !request.headers["content-type"]?.startsWith("multipart/form-data;") ||
          busy || retainedVisibilitySession) {
        send(response, 403, "Forbidden", "text/plain; charset=utf-8"); return;
      }
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 70000) throw Error("File too large");
          chunks.push(chunk);
        }
        const upload = new Request(localOrigin + request.url, {
          method: "POST", headers: { "Content-Type": request.headers["content-type"] },
          body: Buffer.concat(chunks),
        });
        const form = await upload.formData();
        const supplied = Buffer.from(String(form.get("csrf") ?? ""), "utf8");
        const actual = Buffer.from(csrf, "utf8");
        const file = form.get("job");
        if (supplied.length !== actual.length || !timingSafeEqual(supplied, actual) ||
            [...form.keys()].sort().join() !== "csrf,job" ||
            typeof file?.arrayBuffer !== "function" ||
            file.size < 1 || file.size > 65536)
          throw Error("Invalid import");
        const pack = JSON.parse(new TextDecoder("utf-8", { fatal: true })
          .decode(await file.arrayBuffer()));
        if (pack?.inventoryId !== B005396_INVENTORY)
          throw Error("Wrong inventory");
        await enqueueGeneralPrivateCreate(options.root, pack);
        message = "B005396の準備内容をPCに読み込みました。Shopsへの送信・保存・公開は行っていません。";
      } catch {
        message = "B005396の準備ファイルを確認できませんでした。Shopsへの送信・保存・公開は行っていません。";
      }
      response.writeHead(303, { Location: "/", "Cache-Control": "no-store" });
      response.end(); return;
    }
    if (request.method === "POST" && request.url === "/visibility-import") {
      if (options.createTestObservationEnabled ||
          persistedGeneralDraftHold || retainedGeneralDraftSession ||
          request.headers.origin !== localOrigin ||
          !request.headers["content-type"]?.startsWith("multipart/form-data;") ||
          busy || retainedVisibilitySession) {
        send(response, 403, "Forbidden", "text/plain; charset=utf-8"); return;
      }
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 12288) throw Error("File too large");
          chunks.push(chunk);
        }
        const upload = new Request(localOrigin + "/visibility-import", {
          method: "POST", headers: { "Content-Type": request.headers["content-type"] },
          body: Buffer.concat(chunks),
        });
        const form = await upload.formData();
        const supplied = Buffer.from(String(form.get("csrf") ?? ""), "utf8");
        const actual = Buffer.from(csrf, "utf8");
        const file = form.get("job");
        if (supplied.length !== actual.length || !timingSafeEqual(supplied, actual) ||
            typeof file?.text !== "function" || file.size < 1 || file.size > 8192)
          throw Error("Invalid import");
        await enqueueVisibility(options.root, JSON.parse(await file.text()));
        message = "PCジョブを読み込みました。Shopsはまだ変更していません。";
      } catch {
        message = "PCジョブを確認できませんでした。Shopsは変更していません。";
      }
      response.writeHead(303, { Location: "/", "Cache-Control": "no-store" });
      response.end(); return;
    }
    if (request.method === "GET" && request.url === "/") {
      let visibilityJobs = [];
      try { visibilityJobs = await Promise.all((await listVisibilityPcJobs(
        options.root)).map(async item => ({ ...item,
          publicVerified: item.job.action === "STOP" &&
            (await readPublicVisibility(options.root, item.job.target))
              .allowStop === true }))); }
      catch { message = "PCジョブの保存状態を確認できません。Shops操作は行っていません。"; }
      let generalCreateJobs = [];
      try { generalCreateJobs = await listGeneralPrivateCreateJobs(options.root); }
      catch { message = "新規出品の準備記録を確認できません。Shops操作は行っていません。"; }
      let listingWindow;
      try { listingWindow = await readShopListingWindow(options.root, CREATE_TEST_TARGET.shopId); }
      catch { listingWindow = { remainingSeconds: null, nextAllowedAt: null }; }
      send(response, 200, page({ csrf, options, message, busy, workflowRunning,
        recoveryRunning,
        belloOpen: Boolean(belloContext), shopsOpen: Boolean(shopsContext),
        manualOpen: Boolean(manualSession), manualAttempted, lastManual, lastResult,
        trafficAttempted, lastTraffic, lastReadQueries, lastDiagnostics,
        directProbeAvailable, directProbeState, directProbeReported,
        privateSaveAttempted, lastPrivateSave,
        trafficEvidenceStatus, trafficEvidenceAt,
        lastPrivateReadback, lastPrivateDiagnostic,
        retainedSaveOpen: Boolean(retainedSaveSession), imageAttempted, lastImageStatus,
        lastImageDiagnostic, retainedImageOpen: Boolean(retainedImageSession),
        lastImageReadState, workflowAttempted: workflowUsed, lastWorkflowStatus,
        lastWorkflowStage, lastImagePreflight, lastWorkflowReadback,
        lastWorkflowReadbackReason,
        recoveryAttempted: recoveryUsed, recoveryClaimed,
        lastRecoveryStatus, lastRecoveryStage,
        recoveryReadbackPrivateWithImage,
        workflowReadbackPrivateWithImage,
        savedProductReadback,
        retainedWorkflowOpen: Boolean(retainedWorkflowSession),
        createClaim, createPreflight, createResult, createOpen: Boolean(createSession),
        createArmed, visibilityJobs, generalCreateJobs, listingWindow,
        offlineDraftActionEnabled,
        retainedGeneralDraftOpen: Boolean(retainedGeneralDraftSession) ||
          persistedGeneralDraftHold,
        retainedVisibilityOpen: Boolean(retainedVisibilitySession) }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/action" ||
        request.headers.origin !== localOrigin ||
        !request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) {
      send(response, 403, "Forbidden", "text/plain; charset=utf-8"); return;
    }
    let body = "";
    try {
      for await (const chunk of request) {
        body += chunk.toString("utf8");
        if (Buffer.byteLength(body) > 4096) {
          send(response, 413, "Too large", "text/plain; charset=utf-8"); return;
        }
      }
    } catch { send(response, 400, "Invalid request", "text/plain; charset=utf-8"); return; }
    const form = new URLSearchParams(body);
    const requestedAction = form.get("action");
    const supplied = Buffer.from(form.get("csrf") ?? "", "utf8");
    const actual = Buffer.from(csrf, "utf8");
    if (supplied.length !== actual.length || !timingSafeEqual(supplied, actual) ||
        busy || workflowRunning || recoveryRunning || retainedVisibilitySession ||
        ((retainedGeneralDraftSession || persistedGeneralDraftHold) &&
          requestedAction !== "recover-general-draft-session")) {
      send(response, 403, "Forbidden", "text/plain; charset=utf-8"); return;
    }
    busy = true;
    let shutdown = false;
    let proofDownload = null;
    try {
      const action = form.get("action");
      if (options.createTestObservationEnabled &&
          !["create-test-open", "create-test-arm", "create-test-finish", "shutdown"]
            .includes(action))
        throw Error("Only the pinned private-create observation is available");
      if (action === "recover-general-draft-session") {
        if (!retainedGeneralDraftSession && !persistedGeneralDraftHold)
          throw Error("No unresolved draft screen");
        if (retainedGeneralDraftSession)
          await retainedGeneralDraftSession.context.close();
        await recordGeneralPrivateDraftScreenRecovery(options.root);
        retainedGeneralDraftSession = null;
        persistedGeneralDraftHold = false;
        message = "未解決のShops画面を回収しました。元の下書き保存は再実行できません。";
      } else if (action === "verify-public-visibility") {
        const key = form.get("jobKey");
        if (!HASH.test(key ?? "") || shopsContext || manualSession ||
            retainedSaveSession || retainedImageSession || retainedWorkflowSession ||
            createSession)
          throw Error("Public visibility read cannot start during another Shops session");
        const job = await readVisibilityPcJob(options.root, key);
        if (job.action !== "STOP") throw Error("Only STOP targets need public proof");
        const observed = await verifyPublicVisibility({ root: options.root,
          profileDir: options.shopsProfileDir,
          playwrightModulePath: options.playwrightModulePath,
          target: job.target });
        message = observed?.status === "PUBLIC_CONFIRMED" &&
          observed.remoteId === job.target.remoteId ?
          "同じShops商品IDの公開状態を読み取りました。停止操作はしていません。" :
          "Shopsの商品IDと公開状態を確認できませんでした。停止操作はできません。";
      } else if (action === "run-visibility-job") {
        const key = form.get("jobKey");
        if (!HASH.test(key ?? "") || shopsContext || manualSession ||
            retainedSaveSession || retainedImageSession || retainedWorkflowSession ||
            createSession)
          throw Error("Visibility job cannot start during another Shops session");
        const job = await readVisibilityPcJob(options.root, key);
        if (job.action === "RELIST")
          throw Error("Relist UI is under read-only review");
        if (job.action === "STOP" &&
            (await readPublicVisibility(options.root, job.target))
              .allowStop !== true)
          throw Error("Exact public product proof is required before STOP");
        const result = await runVisibility({ root: options.root,
          profileDir: options.shopsProfileDir,
          playwrightModulePath: options.playwrightModulePath,
          action: job.action, target: job.target, listing: job.listing });
        if (result.retainedSession) {
          retainedVisibilitySession = result.retainedSession;
          result.retainedSession.context.once("close", () => {
            if (retainedVisibilitySession === result.retainedSession)
              retainedVisibilitySession = null;
          });
        }
        message = result.status === "STOP_VERIFIED" ?
          "Shopsの商品IDと非公開状態を再読込して、停止を確認しました。" :
          result.status === "RELIST_VERIFIED" ?
            "Shopsの商品IDと公開状態を再読込して、再出品を確認しました。" :
            result.status === "PREFLIGHT_BLOCKED" ?
              "停止済みの証拠または対象状態を確認できません。Shops操作は行っていません。" :
              "結果は未確認です。同じ操作を再実行できません。Shops画面を確認してください。";
      } else if (action === "run-general-private-draft") {
        if (!offlineDraftActionEnabled ||
            form.get("inventoryId") !== B005396_INVENTORY ||
            shopsContext || manualSession || retainedSaveSession ||
            retainedImageSession || retainedWorkflowSession || createSession)
          throw Error("General private draft action is under review");
        const result = await runGeneralDraft({ root: options.root,
          inventoryId: B005396_INVENTORY, origin: options.origin,
          belloProfileDir: options.belloProfileDir,
          shopsProfileDir: options.shopsProfileDir,
          playwrightModulePath: options.playwrightModulePath });
        if (result?.retainedSession?.context) {
          retainedGeneralDraftSession = result.retainedSession;
        }
        persistedGeneralDraftHold = await generalPrivateDraftOccupationActive(
          options.root);
        message = result?.status === "PRIVATE_DRAFT_READBACK_CONFIRMED" ?
          "Shopsの同じ商品IDと非公開下書き状態を別ページで再読込して確認しました。公開はしていません。" :
          result?.diagnostic === "REVIEW_HOLD" ?
          "独立レビュー中のため、Shopsへの保存は実行していません。" :
          result?.status === "BLOCKED" ?
            "保存前の照合で停止しました。Shopsへの保存は実行していません。" :
            "下書き保存の結果は未確認です。同じ操作は再実行せず、専用画面と保存記録を確認してください。";
      } else if (action === "create-test-open") {
        if (!options.createTestObservationEnabled || createClaim.claimed ||
            !createPreflight.clear || createSession ||
            shopsContext || manualSession || retainedSaveSession || retainedImageSession ||
            retainedWorkflowSession)
          throw Error("The private-create observation is unavailable");
        createClaim = { claimed: true, valid: true,
          ...await claimCreate(options.root) };
        createPreflight = { clear: false, reason: "PRIOR_CREATE_ATTEMPT" };
        const session = await openCreateList({ root: options.root,
          profileDir: options.shopsProfileDir,
          playwrightModulePath: options.playwrightModulePath,
          shopId: CREATE_TEST_TARGET.shopId });
        if (session.state !== "LIST_OPEN") {
          await session.context.close();
          throw Error("The exact Shops product list is not open");
        }
        createSession = { ...session, observer: null };
        session.context.once("close", () => {
          const active = createSession;
          if (active) void finishCreate(true, active).catch(() => {
            message = "作成結果は未確認です。再送しません。";
          }).finally(() => { if (createSession === active) createSession = null; });
        });
        message = "専用Shops画面を開きました。新規商品を非公開で準備してください。既存公開商品は変更しません。";
      } else if (action === "create-test-arm") {
        if (!options.createTestObservationEnabled || !createSession ||
            !createClaim.claimed || !createClaim.valid || createArmed || createResult)
          throw Error("Private-create observation cannot be armed");
        const createPath = `/seller/shops/${CREATE_TEST_TARGET.shopId}/products/create`;
        const pages = createSession.context.pages().filter(candidate => {
          try {
            const url = new URL(candidate.url());
            return url.origin === "https://mercari-shops.com" &&
              url.pathname === createPath && !url.search && !url.hash;
          } catch { return false; }
        });
        if (pages.length !== 1) throw Error("The observed new-product form is required");
        const observer = observeCreate(createSession.context, {
          page: pages[0], target: CREATE_TEST_TARGET, timeoutMs: 12000 });
        observer.arm();
        createSession.observer = observer;
        createArmed = true;
        message = "観測を開始しました。内容を最終確認し、Shops画面で非公開保存を1回だけ行ってください。";
      } else if (action === "create-test-finish") {
        if (!options.createTestObservationEnabled || !createSession || !createArmed ||
            !createSession.observer || createResult)
          throw Error("No private-create observation is active");
        const result = await finishCreate();
        message = result?.outcome === "OBSERVED_PRIVATE_CREATE_RESPONSE" ?
          "通常画面の新規作成応答を記録しました。非公開・価格・画像の読戻しは別途必要です。" :
          "作成結果を確認できませんでした。再送せず、Shopsの既存商品を読取で確認してください。";
      } else if (action === "bello-login") {
        if (belloContext) throw Error("BELLO browser already open");
        belloContext = await openBello({ origin: options.origin, profileDir: options.belloProfileDir,
          playwrightModulePath: options.playwrightModulePath, navigateToLogin: true });
        belloContext.once("close", () => { belloContext = null; });
        message = "BELLOの専用ブラウザを開きました。通常ログイン後、ブラウザを閉じてください。";
      } else if (action === "shops-login") {
        if (shopsContext || retainedSaveSession || retainedImageSession || retainedWorkflowSession)
          throw Error("Shops browser already open");
        shopsContext = await openShops({ profileDir: options.shopsProfileDir,
          playwrightModulePath: options.playwrightModulePath });
        shopsContext.once("close", () => { shopsContext = null; });
        message = "Shopsの専用ブラウザを開きました。通常ログイン後、ブラウザを閉じてください。";
      } else if (action === "read") {
        if (manualSession || retainedSaveSession || retainedImageSession || retainedWorkflowSession)
          throw Error("Close the Shops browser first");
        if (belloContext) { await belloContext.close(); belloContext = null; }
        if (shopsContext) { await shopsContext.close(); shopsContext = null; }
        trafficAttempted = true;
        lastTraffic = [];
        lastReadQueries = [];
        lastDiagnostics = [];
        trafficEvidenceStatus = "READ_IN_PROGRESS";
        trafficEvidenceAt = null;
        const result = await runRead({ origin: options.origin, requestId: options.requestId,
          root: options.root, belloProfileDir: options.belloProfileDir,
          shopsProfileDir: options.shopsProfileDir, playwrightModulePath: options.playwrightModulePath,
          browserRead: true, onShopsTraffic: (items, queryCandidates) => {
            lastTraffic = safeShopsTrafficSummary(items);
            lastReadQueries = safeReadQueryCandidates(queryCandidates);
          },
          onReadDiagnostics: codes => { lastDiagnostics = safeReadDiagnostics(codes); },
          onTrafficEvidenceStatus: (status, observedAt) => {
            trafficEvidenceStatus = status;
            trafficEvidenceAt = observedAt;
          } });
        if (trafficEvidenceStatus === "READ_IN_PROGRESS")
          trafficEvidenceStatus = "STORE_STATUS_UNCONFIRMED";
        if (options.directReadTarget && !directProbeState.claimed) {
          try { directProbeAvailable = await directReadProbeAvailable(options.root,
            options.requestId, options.directReadTarget); } catch { directProbeAvailable = false; }
        }
        lastResult = result.status;
        message = "照合結果をBELLOへ報告しました。BELLO画面で内容を確認してください。";
      } else if (action === "probe-direct-read-once") {
        if (!options.directReadTarget || !directProbeAvailable || directProbeState.claimed ||
            shopsContext || manualSession || retainedSaveSession || retainedImageSession ||
            retainedWorkflowSession)
          throw Error("Exact read probe is unavailable");
        try {
          const result = await runDirectReadProbe({ root: options.root,
            profileDir: options.shopsProfileDir,
            playwrightModulePath: options.playwrightModulePath,
            requestId: options.requestId, target: options.directReadTarget });
          directProbeState = { claimed: true, ...result };
          message = "既存商品のHTTP読取検証を記録しました。商品は変更していません。";
        } finally {
          directProbeAvailable = false;
          directProbeState = await readDirectReadProbeOutcome(options.root,
            options.directReadTarget);
        }
      } else if (action === "report-direct-read-proof") {
        if (!options.directReadTarget || directProbeReported ||
            directProbeState.outcome !== "MATCHED" || directProbeState.httpStatus !== 200 ||
            belloContext || shopsContext || manualSession || retainedSaveSession ||
            retainedImageSession || retainedWorkflowSession)
          throw Error("Direct read proof is unavailable");
        await reportDirectRead({ origin: options.origin, requestId: options.requestId,
          root: options.root, belloProfileDir: options.belloProfileDir,
          playwrightModulePath: options.playwrightModulePath,
          target: options.directReadTarget });
        directProbeReported = true;
        message = "保存済みの直接HTTP読取結果をBELLOへ報告しました。出品や書込の確認ではありません。";
      } else if (action === "download-direct-read-proof") {
        if (!options.directReadTarget || directProbeState.outcome !== "MATCHED" ||
            directProbeState.httpStatus !== 200)
          throw Error("Direct read proof is unavailable");
        proofDownload = await savedDirectReadProofRecord(options.root, options.requestId,
          options.directReadTarget);
      } else if (action === "verify-saved-product-readonly") {
        if (!options.manualObservation || !options.imageProof || shopsContext || manualSession ||
            retainedSaveSession || retainedImageSession || retainedWorkflowSession)
          throw Error("Saved-product readback is unavailable while Shops Chrome is open");
        const result = await runSavedProductReadback({ root: options.root,
          profileDir: options.shopsProfileDir,
          playwrightModulePath: options.playwrightModulePath,
          target: options.manualObservation, imageSha256: options.imageProof.sha256 });
        savedProductReadback = ["OBSERVED_PRIVATE_TWO_IMAGES", "UNKNOWN", "AUTH_REQUIRED",
          "PRIOR_ATTEMPT_MISMATCH"].includes(result?.status) ?
          { status: result.status,
            imageOutcome: ["UNKNOWN", "BLOCKED_BEFORE_SELECT", "UNRECORDED"].includes(
              result.imageOutcome) ? result.imageOutcome : "UNRECORDED",
            saveOutcome: ["CONFIRMED_PRIVATE", "UNKNOWN", "BLOCKED_BEFORE_CLICK",
              "UNRECORDED"].includes(result.saveOutcome) ? result.saveOutcome : "UNRECORDED" } :
          { status: "UNKNOWN", imageOutcome: "UNRECORDED", saveOutcome: "UNRECORDED" };
        message = "既存商品の読取確認を記録しました。保存や画像追加は実行していません。";
      } else if (action === "observe-start") {
        if (!options.manualObservation || manualSession || retainedSaveSession || retainedImageSession || privateSaveAttempted)
          throw Error("Manual observation is unavailable");
        if (shopsContext) { await shopsContext.close(); shopsContext = null; }
        manualAttempted = false;
        lastManual = [];
        manualSession = await openManualObservation({ root: options.root,
          profileDir: options.shopsProfileDir, playwrightModulePath: options.playwrightModulePath,
          shopId: options.manualObservation.shopId, remoteId: options.manualObservation.remoteId });
        manualSession.context.once("close", () => {
          void finishManual().catch(() => { lastManual = []; message = "通信観測の概要を取得できませんでした。"; });
        });
        message = "対象の専用Chromeを開きました。価格・数量・非公開を確認し、内容を変えない保存1回だけを観測します。";
      } else if (action === "save-private-once") {
        if (!options.manualObservation || manualSession || retainedImageSession)
          throw Error("Exact-product private save is unavailable");
        if (privateSaveAttempted) {
          message = "この商品の保存操作は実行済み、または結果不明です。再実行できません。";
        } else {
          if (retainedSaveSession) throw Error("Existing save observation is active");
          if (shopsContext) { await shopsContext.close(); shopsContext = null; }
          try {
            const result = await runPrivateSave({ root: options.root,
              profileDir: options.shopsProfileDir, playwrightModulePath: options.playwrightModulePath,
              target: options.manualObservation,
              onMetadata: items => { lastManual = safeManualMutationSummary(items); manualAttempted = true; } });
            lastPrivateSave = ["CONFIRMED_PRIVATE", "UNKNOWN", "BLOCKED_BEFORE_CLICK",
              "ALREADY_ATTEMPTED", "PREFLIGHT_BLOCKED"].includes(result?.status) ? result.status : "UNKNOWN";
            lastPrivateReadback = result?.postflightPrivate === true;
            lastPrivateDiagnostic = ["CLAIMED_BEFORE_NEXT", "NEXT_CONTROL_CHECK",
              "NEXT_CLICK_UNCERTAIN", "POST_NEXT_FIELDS_CHECK", "PRIVATE_CONTROL_CHECK",
              "PRIVATE_CLICK_UNCERTAIN", "PRIVATE_CLICK_RETURNED"].includes(result?.diagnostic) ?
              result.diagnostic : "";
            if (result?.retainedSession?.context && result?.retainedSession?.observer &&
                typeof result.retainedSession.onClose === "function") {
              retainedSaveSession = result.retainedSession;
              retainedSaveSession.onClose(() => {
                const session = retainedSaveSession;
                retainedSaveSession = null;
                if (session) void session.observer.stop().then(items => {
                  lastManual = safeManualMutationSummary(items);
                  manualAttempted = true;
                }).catch(() => {});
              });
            }
            message = lastPrivateSave === "CONFIRMED_PRIVATE" ?
              "既存商品の非公開保存を確認しました。新規出品の確認ではありません。" :
              lastPrivateSave === "PREFLIGHT_BLOCKED" ?
                "保存前の確認で停止しました。Shopsへの保存操作はしていません。" :
                "保存結果を確認できませんでした。再送せず、読取で確認してください。";
          } finally {
            privateSaveAttempted = Boolean((await readManualSaveClaim(options.root,
              options.manualObservation)).claimed);
          }
        }
      } else if (action === "refresh-save-observation") {
        if (!retainedSaveSession) throw Error("No retained save observation is active");
        lastManual = safeManualMutationSummary(retainedSaveSession.observer.snapshot());
        manualAttempted = true;
        message = "通信概要を更新しました。保存成功の判定は保留のままです。";
      } else if (action === "add-image-once") {
        if (!options.imageProof || !options.manualObservation || manualSession || retainedSaveSession)
          throw Error("Exact-product image proof is unavailable");
        if (imageAttempted) {
          message = "この商品の画像選択は試行済み、または結果不明です。再実行できません。";
        } else {
          if (retainedImageSession) throw Error("Existing image observation is active");
          if (shopsContext) { await shopsContext.close(); shopsContext = null; }
          try {
            const result = await runImageAdd({ root: options.root,
              profileDir: options.shopsProfileDir, playwrightModulePath: options.playwrightModulePath,
              target: options.manualObservation, imagePath: options.imageProof.path,
              imageSha256: options.imageProof.sha256,
              onMetadata: items => { lastManual = safeManualMutationSummary(items); manualAttempted = true; } });
            lastImageStatus = ["UNKNOWN", "BLOCKED_BEFORE_SELECT", "ALREADY_ATTEMPTED",
              "PREFLIGHT_BLOCKED"].includes(result?.status) ? result.status : "UNKNOWN";
            lastImageDiagnostic = ["CLAIMED_BEFORE_SELECT", "FILE_INPUT_CHECK",
              "FINAL_TARGET_CHECK", "FILE_SELECT_UNCERTAIN", "FILE_SELECT_RETURNED",
              "ORIGINAL_IMAGE_NOT_OBSERVED", "ADDED_IMAGE_UI_OBSERVED"].includes(result?.diagnostic) ?
              result.diagnostic : "";
            if (result?.retainedSession?.context && result?.retainedSession?.observer &&
                typeof result.retainedSession.onClose === "function") {
              retainedImageSession = result.retainedSession;
              retainedImageSession.onClose(() => {
                const session = retainedImageSession;
                retainedImageSession = null;
                if (session) void session.observer.stop().then(items => {
                  lastManual = safeManualMutationSummary(items);
                  manualAttempted = true;
                }).catch(() => {});
              });
            }
            message = lastImageStatus === "PREFLIGHT_BLOCKED" ?
              "画像選択前の確認で停止しました。画像は送信していません。" :
              "画像選択の結果は未確定です。再送せず、専用Chromeと通信概要を確認してください。";
          } finally {
            imageAttempted = Boolean((await readManualImageClaim(options.root,
              options.manualObservation, options.imageProof.sha256)).claimed);
          }
        }
      } else if (action === "refresh-image-observation") {
        if (!retainedImageSession) throw Error("No retained image observation is active");
        lastManual = safeManualMutationSummary(retainedImageSession.observer.snapshot());
        manualAttempted = true;
        message = "画像通信の概要を更新しました。商品保存の判定は保留のままです。";
      } else if (action === "inspect-retained-image") {
        if (!retainedImageSession || !options.manualObservation)
          throw Error("No retained image page is active");
        try {
          const result = await inspectImage(retainedImageSession, options.manualObservation);
          lastImageReadState = ["PAGE_UNVERIFIED", "IMAGES_UNVERIFIED",
            "ORIGINAL_UNVERIFIED", "ORIGINAL_ONLY_VISIBLE",
            "ORIGINAL_AND_ONE_ADDITION_VISIBLE", "IMAGE_COUNT_UNVERIFIED"].includes(result) ?
            result : "IMAGES_UNVERIFIED";
        } catch { lastImageReadState = "IMAGES_UNVERIFIED"; }
        message = "現在開いている画面だけを読み取りました。商品保存の判定は保留のままです。";
      } else if (action === "inspect-image-preflight") {
        if (!options.imageWorkflowEnabled ||
            !isPinnedB005757ImageTarget(options.manualObservation, options.requestId) ||
            !options.imageProof ||
            shopsContext || manualSession || retainedSaveSession || retainedImageSession ||
            retainedWorkflowSession)
          throw Error("Private-image read-only preflight is unavailable");
        const result = await runImagePreflight({ root: options.root,
          profileDir: options.shopsProfileDir,
          playwrightModulePath: options.playwrightModulePath,
          requestId: options.requestId, target: options.manualObservation,
          imagePath: options.imageProof.path,
          imageSha256: options.imageProof.sha256 });
        lastImagePreflight = (
          (result?.status === "READY" && result.reasonCode === "EXACT_PRIVATE_PRODUCT_READY") ||
          (result?.status === "AUTH_REQUIRED" && result.reasonCode === "LOGIN_REQUIRED") ||
          (result?.status === "PREFLIGHT_BLOCKED" && IMAGE_PREFLIGHT_BLOCKS.has(result.reasonCode))
        ) ?
          { status: result.status, reasonCode: result.reasonCode } :
          { status: "PREFLIGHT_BLOCKED", reasonCode: "READ_FAILED" };
        message = "既存商品を読取だけで事前確認しました。画像選択と保存は行っていません。";
      } else if (action === "complete-image-private") {
        if (!options.imageWorkflowEnabled || workflowUsed || manualSession || retainedSaveSession ||
            retainedImageSession || retainedWorkflowSession || shopsContext ||
            (options.manualObservation?.remoteId === PINNED_B005757_REMOTE_ID &&
              (!isPinnedB005757ImageTarget(options.manualObservation, options.requestId) ||
                lastImagePreflight?.status !== "READY")))
          throw Error("Private-image workflow is unavailable");
        workflowRunning = true;
        workflowUsed = true;
        lastWorkflowStatus = "";
        lastWorkflowStage = "";
        workflowReadbackPrivateWithImage = false;
        message = "既存商品の確認から非公開保存後の再読込まで進めています。";
        void (async () => {
          try {
            const result = await runWorkflow({ root: options.root,
              profileDir: options.shopsProfileDir, playwrightModulePath: options.playwrightModulePath,
              target: options.manualObservation, imagePath: options.imageProof.path,
              imageSha256: options.imageProof.sha256,
              onStage: stage => {
                if (WORKFLOW_STAGES.has(stage)) lastWorkflowStage = stage;
              },
              onMetadata: items => { lastManual = safeManualMutationSummary(items); manualAttempted = true; } });
            lastWorkflowStatus = ["CONFIRMED_PRIVATE_WITH_IMAGE", "UNKNOWN", "AUTH_REQUIRED",
              "PREFLIGHT_BLOCKED", "BLOCKED_PREVIOUS_ATTEMPT"].includes(result?.status) ?
              result.status : "UNKNOWN";
            lastWorkflowStage = WORKFLOW_STAGES.has(result?.stage) ? result.stage : lastWorkflowStage;
            workflowReadbackPrivateWithImage = result?.readbackPrivateWithImage === true;
            if (result?.retainedSession?.context && result?.retainedSession?.observer &&
                result.retainedSession.page &&
                typeof result.retainedSession.onClose === "function") {
              retainedWorkflowSession = result.retainedSession;
              retainedWorkflowSession.onClose(() => {
                const session = retainedWorkflowSession;
                retainedWorkflowSession = null;
                if (session) void session.observer.stop().then(items => {
                  lastManual = safeManualMutationSummary(items); manualAttempted = true;
                }).catch(() => {});
              });
            }
            message = lastWorkflowStatus === "CONFIRMED_PRIVATE_WITH_IMAGE" ?
              "既存商品に画像2枚が残り、非公開であることを再読込で確認しました。" :
              "工程は停止しました。画像や保存を再送せず、結果を確認してください。";
          } catch {
            lastWorkflowStatus = "UNKNOWN";
            message = "工程を確認できませんでした。画像や保存を再送しません。";
          } finally {
            // One explicit click is never repeated in the same PC session, even before a claim.
            workflowUsed = true;
            workflowRunning = false;
          }
        })();
      } else if (action === "refresh-workflow-observation") {
        if (!retainedWorkflowSession) throw Error("No retained workflow observation is active");
        lastManual = safeManualMutationSummary(retainedWorkflowSession.observer.snapshot());
        manualAttempted = true;
        message = "工程の通信概要を更新しました。未確認の結果は再送しません。";
      } else if (action === "inspect-workflow-image") {
        if (!retainedWorkflowSession) throw Error("No retained workflow page is active");
        try {
          const readState = await inspectImage(retainedWorkflowSession, options.manualObservation);
          lastImageReadState = ["PAGE_UNVERIFIED", "IMAGES_UNVERIFIED", "ORIGINAL_UNVERIFIED",
            "ORIGINAL_ONLY_VISIBLE", "ORIGINAL_AND_ONE_ADDITION_VISIBLE",
            "IMAGE_COUNT_UNVERIFIED"].includes(readState) ? readState : "IMAGES_UNVERIFIED";
        } catch { lastImageReadState = "IMAGES_UNVERIFIED"; }
        message = "保持中の商品画面を読み取りました。未確認の保存は再送しません。";
      } else if (action === "verify-workflow-readonly") {
        if (!options.imageWorkflowEnabled || !options.imageProof ||
            !isPinnedB005757ImageTarget(options.manualObservation, options.requestId) ||
            !workflowUsed || lastWorkflowStatus !== "UNKNOWN" ||
            lastWorkflowStage !== "FILE_SELECTION_UNCERTAIN" ||
            shopsContext || manualSession || retainedSaveSession || retainedImageSession ||
            retainedWorkflowSession)
          throw Error("Private-image read-only recovery is unavailable");
        const result = await runWorkflowReadback({ root: options.root,
          profileDir: options.shopsProfileDir,
          playwrightModulePath: options.playwrightModulePath,
          requestId: options.requestId, target: options.manualObservation });
        lastWorkflowReadback = ["PRIVATE_ONE_IMAGE_OBSERVED",
          "PRIVATE_TWO_IMAGES_UNATTRIBUTED", "AUTH_REQUIRED", "UNVERIFIED",
          "NO_ELIGIBLE_ATTEMPT"].includes(result?.status) ? result.status : "UNVERIFIED";
        lastWorkflowReadbackReason = lastWorkflowReadback === "UNVERIFIED" &&
          ["NAVIGATION_UNVERIFIED", "FIELDS_UNVERIFIED", "IMAGES_UNVERIFIED",
            "PRIVATE_STATE_UNVERIFIED", "RECHECK_UNVERIFIED", "READ_FAILED"]
            .includes(result?.reasonCode) ? result.reasonCode : "";
        message = "現在の非公開状態と画像枚数を読取だけで確認しました。画像選択と保存は行っていません。";
      } else if (action === "recover-image-once") {
        if (!options.imageWorkflowEnabled || !options.imageProof ||
            !isPinnedB005757ImageTarget(options.manualObservation, options.requestId) ||
            !workflowUsed || lastWorkflowStatus !== "UNKNOWN" ||
            lastWorkflowStage !== "FILE_SELECTION_UNCERTAIN" ||
            lastWorkflowReadback !== "PRIVATE_ONE_IMAGE_OBSERVED" || recoveryUsed ||
            shopsContext || manualSession || retainedSaveSession || retainedImageSession ||
            retainedWorkflowSession)
          throw Error("Private-image recovery is unavailable");
        recoveryUsed = true;
        recoveryRunning = true;
        lastRecoveryStatus = "";
        lastRecoveryStage = "";
        recoveryReadbackPrivateWithImage = false;
        message = "同じ非公開商品について一回限りの復旧を確認しています。";
        void (async () => {
          try {
            const result = await runRecovery({ root: options.root,
              profileDir: options.shopsProfileDir,
              playwrightModulePath: options.playwrightModulePath,
              requestId: options.requestId, target: options.manualObservation,
              imagePath: options.imageProof.path,
              imageSha256: options.imageProof.sha256,
              readbackObserved: lastWorkflowReadback,
              onStage: stage => {
                if (WORKFLOW_STAGES.has(stage)) lastRecoveryStage = stage;
              },
              onMetadata: items => {
                lastManual = safeManualMutationSummary(items); manualAttempted = true;
              } });
            lastRecoveryStatus = ["CONFIRMED_PRIVATE_WITH_IMAGE", "UNKNOWN",
              "AUTH_REQUIRED", "PREFLIGHT_BLOCKED", "BLOCKED_PREVIOUS_ATTEMPT"]
              .includes(result?.status) ? result.status : "UNKNOWN";
            lastRecoveryStage = WORKFLOW_STAGES.has(result?.stage) ?
              result.stage : lastRecoveryStage;
            recoveryReadbackPrivateWithImage = result?.readbackPrivateWithImage === true;
            if (result?.retainedSession?.context && result.retainedSession.observer &&
                result.retainedSession.page &&
                typeof result.retainedSession.onClose === "function") {
              retainedWorkflowSession = result.retainedSession;
              retainedWorkflowSession.onClose(() => {
                const session = retainedWorkflowSession;
                retainedWorkflowSession = null;
                if (session) void session.observer.stop().then(items => {
                  lastManual = safeManualMutationSummary(items); manualAttempted = true;
                }).catch(() => {});
              });
            }
            message = lastRecoveryStatus === "CONFIRMED_PRIVATE_WITH_IMAGE" ?
              "対象商品が非公開で画像2枚と再確認できました。" :
              "復旧工程は停止しました。画像や保存を再送しないでください。";
          } catch {
            lastRecoveryStatus = "UNKNOWN";
            message = "復旧工程を確認できませんでした。画像や保存を再送しません。";
          } finally {
            recoveryUsed = true;
            try {
              recoveryClaimed = Boolean((await readPrivateImageRecoveryClaim(options.root,
                options.manualObservation, options.requestId)).claimed);
            } catch { recoveryClaimed = true; }
            recoveryRunning = false;
          }
        })();
      } else if (action === "observe-stop") {
        if (!manualSession) throw Error("No manual observation is active");
        const session = manualSession;
        try { await finishManual(); }
        finally { await session.context.close(); }
        message = "通信観測を終了しました。概要はこのPC画面にだけ表示します。";
      } else if (action === "retry-report") {
        if (!options.recovery) throw Error("No saved read selected");
        if (belloContext) { await belloContext.close(); belloContext = null; }
        const result = await reportRead({ origin: options.origin, requestId: options.requestId,
          root: options.root, belloProfileDir: options.belloProfileDir,
          playwrightModulePath: options.playwrightModulePath,
          jobId: options.recovery.jobId, attemptId: options.recovery.attemptId });
        lastResult = result.status;
        message = "保存済みの読取結果をBELLOへ報告しました。Shopsの再読取は行っていません。";
      } else if (action === "shutdown") {
        if (options.createTestObservationEnabled && createSession)
          throw Error("Close the dedicated Shops browser manually before ending the app");
        if (retainedSaveSession || retainedImageSession || retainedWorkflowSession ||
            retainedVisibilitySession)
          throw Error("Shops browser is still open after mutation");
        if (belloContext) { await belloContext.close(); belloContext = null; }
        if (shopsContext) { await shopsContext.close(); shopsContext = null; }
        if (manualSession) {
          const session = manualSession;
          try { await finishManual(); }
          finally { await session.context.close(); }
        }
        shutdown = true;
      } else throw Error("Unknown action");
    } catch (error) {
      if (form.get("action") === "read" && trafficEvidenceStatus === "READ_IN_PROGRESS")
        trafficEvidenceStatus = "READ_FAILED_BEFORE_CAPTURE";
      const stage = error instanceof BridgeBoundaryError ?
        [error.phase, error.httpStatus ? `HTTP ${error.httpStatus}` : null, error.serverCode]
          .filter(Boolean).join(" / ") : null;
      message = options.createTestObservationEnabled ?
        createClaim.claimed ?
          "今回の登録試行は開始済み、または結果不明です。再送せずShops画面を確認してください。" :
          "準備を開始できませんでした。Shopsのログインと対象店舗を確認してください。" :
        form.get("action") === "add-image-once" && imageAttempted ?
        "画像選択の結果を確認できませんでした。再送せず、専用Chromeを確認してください。" :
        form.get("action") === "save-private-once" && privateSaveAttempted ?
        "保存結果を確認できませんでした。再送せず、読取で確認してください。" :
        stage ? `処理を完了できませんでした（${stage}）。自動再試行はしていません。` :
        "処理を完了できませんでした。専用ブラウザのログイン状態と読取依頼を確認してください。";
    } finally { busy = false; }
    if (proofDownload) {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": "attachment; filename=\"bello-direct-read-proof.json\"",
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY" });
      response.end(JSON.stringify(proofDownload) + "\n");
    } else if (shutdown) {
      send(response, 200, "アプリを終了しました。", "text/plain; charset=utf-8");
      server.close();
    } else {
      response.writeHead(303, { Location: "/", "Cache-Control": "no-store" }); response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.controlPort, "127.0.0.1", resolve);
  });
  localOrigin = `http://127.0.0.1:${server.address().port}`;
  if (openBrowser) {
    try { await openBrowser(localOrigin); }
    catch {
      // Keep the local page available so a failed browser dispatch does not hide the app.
      process.stderr.write(`Could not open the browser. BELLO local page: ${localOrigin}\n`);
    }
  }
  return { url: localOrigin, close: async () => {
    if (createSession)
      throw Error("Close the dedicated Shops browser manually before ending the app");
    if (retainedVisibilitySession)
      throw Error("Close the unresolved Shops visibility browser manually before ending the app");
    if (belloContext) await belloContext.close();
    if (shopsContext) await shopsContext.close();
    if (manualSession) {
      const session = manualSession;
      try { await finishManual(); }
      finally { await session.context.close(); }
    }
    await new Promise(resolve => server.close(resolve));
  } };
}

function showLocalBrowser(url) {
  return new Promise((resolve, reject) => {
    // Windows opens the control page in its registered browser; the dedicated Shops
    // sign-in still uses a separate visible Chrome profile in session.mjs.
    const child = spawn("explorer.exe", [url], { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
  const configPath = process.argv[2] === "--config" ? process.argv[3] : null;
  if (!configPath || !isAbsolute(configPath)) throw Error("A prepared absolute configuration path is required");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const app = await startDesktopApp(config, {
    openBrowser: process.env.BELLO_MERCARI_PROTOCOL_LAUNCH === "1" ? null : showLocalBrowser,
  });
  process.stdout.write(`BELLO local page: ${app.url}\n`);
}
