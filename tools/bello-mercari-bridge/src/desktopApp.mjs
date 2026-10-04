import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openBelloAdminContext, validBelloOrigin } from "./belloSession.mjs";
import { openDedicatedLogin, openExistingProductReadSession } from "./session.mjs";
import { BridgeBoundaryError, reportSavedReadResultOnce, runBelloCloudReadOnce } from "./cloudConnector.mjs";
import { safeShopsTrafficSummary } from "./trafficObservation.mjs";
import { safeReadDiagnostics } from "./readDiagnostics.mjs";
import { observeManualShopsMutation, safeManualMutationSummary } from "./manualMutationObservation.mjs";
import { saveExistingPrivateOnce } from "./saveExistingPrivateOnce.mjs";
import { readManualSaveClaim, readManualSaveOutcome } from "./manualSaveAttempt.mjs";

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const html = (value) => String(value).replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);
const here = dirname(fileURLToPath(import.meta.url));

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
  return { origin: config.origin, requestId: config.requestId, dataDir,
    recovery, manualObservation,
    root: join(dataDir, "Queue"), belloProfileDir: join(dataDir, "BELLOChrome"),
    shopsProfileDir: join(dataDir, "ShopsChrome"),
    playwrightModulePath: join(here, "..", "node_modules", "playwright", "package.json") };
}

function page({ csrf, options, message, busy, belloOpen, shopsOpen, manualOpen,
  manualAttempted, lastManual, lastResult, trafficAttempted, lastTraffic, lastDiagnostics,
  privateSaveAttempted, lastPrivateSave, lastPrivateReadback, lastPrivateDiagnostic,
  retainedSaveOpen }) {
  const button = (action, label, disabled = false) =>
    `<form method="post" action="/action"><input type="hidden" name="csrf" value="${html(csrf)}"><input type="hidden" name="action" value="${action}"><button ${disabled || busy ? "disabled" : ""}>${label}</button></form>`;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BELLO メルカリ照合</title><style>
body{font:16px system-ui,sans-serif;background:#f7f8fa;color:#222;margin:0;padding:24px}main{max-width:640px;margin:auto;background:white;border:1px solid #d5d8de;border-radius:12px;padding:24px}h1{font-size:1.4rem;margin-top:0}section{border-top:1px solid #ddd;padding-top:16px;margin-top:20px}button{background:#0868c7;color:white;border:0;border-radius:6px;padding:12px 18px;font-size:1rem;cursor:pointer}button:disabled{opacity:.45;cursor:default}form{display:inline-block;margin:5px 8px 5px 0}small{color:#555}code{overflow-wrap:anywhere}strong{color:#7a3600}
</style></head><body><main><h1>BELLO メルカリShops既存商品照合</h1>
<p>対象は既存の商品IDだけです。新規出品・公開・停止・在庫変更は行いません。</p>
<p><small>BELLO: ${html(options.origin)}<br>読取依頼ID: <code>${html(options.requestId)}</code></small></p>
${message ? `<p role="status"><strong>${html(message)}</strong></p>` : ""}
<section><h2>1. 通常ログイン</h2><p>BELLOとShopsを、それぞれ専用のChromeで開きます。ログインが済んだらブラウザを閉じてください。ログイン情報をコピーしません。</p>
${button("bello-login", belloOpen ? "BELLOログイン画面を開いています" : "BELLOにログイン", belloOpen)}
${button("shops-login", shopsOpen ? "Shopsログイン画面を開いています" : "Shopsにログイン", shopsOpen)}</section>
<section><h2>2. 既存商品を1回照合</h2><p>両方のログイン後に押してください。照合できない項目は未確認のままBELLOへ報告します。</p>
${button("read", "この読取依頼を照合する")}
${options.recovery ? `<p>前回の保存済み読取結果を、Shopsに再アクセスせずBELLOへ報告できます。</p>
${button("retry-report", "前回の結果だけをBELLOへ再報告する")}` : ""}
${lastResult ? `<p>直近の結果: <strong>${html(lastResult)}</strong>。出品完了の確認ではありません。</p>` : ""}
${trafficAttempted ? `<details><summary>Shops通信の概要（${lastTraffic.length}種類）</summary>
<p><small>このPC画面に一時表示します。URLの値・検索条件・認証情報・本文は記録せず、BELLOにも送りません。</small></p>
${lastTraffic.length ? `<ul>${lastTraffic.map(item => `<li><code>${html(item.method)} ${html(item.host)}${html(item.path)}</code> — ${html(item.status)}（${html(item.count)}回）</li>`).join("")}</ul>` : "<p>対象となる通信は観測されませんでした。</p>"}</details>` : ""}</section>
${trafficAttempted ? `<section><h2>読取診断</h2><p><small>このPC画面に一時表示する固定コードです。値やURLは記録せず、BELLOにも送りません。</small></p>
${lastDiagnostics.length ? `<p><code>${lastDiagnostics.map(html).join(" / ")}</code></p>` : "<p>診断コードはありません。照合成功を意味するものではありません。</p>"}</section>` : ""}
${options.manualObservation ? `<section><h2>既存商品の通信観測</h2>
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
${lastManual.length ? `<ol>${lastManual.map(item => `<li><code>${html(item.order)}. ${html(item.method)} ${html(item.host)}${html(item.path)}</code> / ${html(item.bodyType)} / HTTP ${html(item.httpStatus ?? "未確認")} / 認証ヘッダー ${item.auth.authorization ? "あり" : "なし"}、Cookie ${item.auth.cookie ? "あり" : "なし"}、CSRF ${item.auth.csrf ? "あり" : "なし"} / 項目 ${item.fields.map(field => html(`${field.field}:${field.type}`)).join(", ") || "未確認"} / ID ${html(item.id ?? "未確認")} / 状態 ${html(item.state ?? "未確認")}</li>`).join("")}</ol>` : "<p>対象となる送信は観測されませんでした。</p>"}</details>` : ""}</details></section>` : ""}
<section><h2>3. BELLOで結果を見る</h2><p>照合後、BELLOの照合依頼画面で「照合結果を確認する」を押してください。</p>
<p><a href="${html(options.origin)}/inventory/mercari-bridge?requestId=${html(options.requestId)}" target="_blank" rel="noopener noreferrer">BELLOの照合依頼画面を開く</a></p>
${button("shutdown", "このアプリを終了", retainedSaveOpen)}</section>
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
  runPrivateSave = saveExistingPrivateOnce,
  runRead = runBelloCloudReadOnce, reportRead = reportSavedReadResultOnce, openBrowser = null,
} = {}) {
  const options = optionsOf(config);
  let privateSaveAttempted = Boolean(options.manualObservation &&
    (await readManualSaveClaim(options.root, options.manualObservation)).claimed);
  const savedPrivateOutcome = options.manualObservation ?
    await readManualSaveOutcome(options.root, options.manualObservation) : null;
  const csrf = randomBytes(32).toString("hex");
  let busy = false;
  let message = "";
  let lastResult = "";
  let trafficAttempted = false;
  let lastTraffic = [];
  let lastDiagnostics = [];
  let belloContext = null;
  let shopsContext = null;
  let manualSession = null;
  let manualAttempted = false;
  let lastManual = [];
  let lastPrivateSave = savedPrivateOutcome?.outcome ?? "";
  let lastPrivateReadback = savedPrivateOutcome?.postflightPrivate === true;
  let lastPrivateDiagnostic = savedPrivateOutcome?.diagnostic ?? "";
  let retainedSaveSession = null;
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
    if (request.method === "GET" && request.url === "/") {
      send(response, 200, page({ csrf, options, message, busy,
        belloOpen: Boolean(belloContext), shopsOpen: Boolean(shopsContext),
        manualOpen: Boolean(manualSession), manualAttempted, lastManual, lastResult,
        trafficAttempted, lastTraffic, lastDiagnostics, privateSaveAttempted, lastPrivateSave,
        lastPrivateReadback, lastPrivateDiagnostic,
        retainedSaveOpen: Boolean(retainedSaveSession) }));
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
    const supplied = Buffer.from(form.get("csrf") ?? "", "utf8");
    const actual = Buffer.from(csrf, "utf8");
    if (supplied.length !== actual.length || !timingSafeEqual(supplied, actual) || busy) {
      send(response, 403, "Forbidden", "text/plain; charset=utf-8"); return;
    }
    busy = true;
    let shutdown = false;
    try {
      const action = form.get("action");
      if (action === "bello-login") {
        if (belloContext) throw Error("BELLO browser already open");
        belloContext = await openBello({ origin: options.origin, profileDir: options.belloProfileDir,
          playwrightModulePath: options.playwrightModulePath, navigateToLogin: true });
        belloContext.once("close", () => { belloContext = null; });
        message = "BELLOの専用ブラウザを開きました。通常ログイン後、ブラウザを閉じてください。";
      } else if (action === "shops-login") {
        if (shopsContext || retainedSaveSession) throw Error("Shops browser already open");
        shopsContext = await openShops({ profileDir: options.shopsProfileDir,
          playwrightModulePath: options.playwrightModulePath });
        shopsContext.once("close", () => { shopsContext = null; });
        message = "Shopsの専用ブラウザを開きました。通常ログイン後、ブラウザを閉じてください。";
      } else if (action === "read") {
        if (manualSession || retainedSaveSession) throw Error("Close the Shops browser first");
        if (belloContext) { await belloContext.close(); belloContext = null; }
        if (shopsContext) { await shopsContext.close(); shopsContext = null; }
        trafficAttempted = true;
        lastTraffic = [];
        lastDiagnostics = [];
        const result = await runRead({ origin: options.origin, requestId: options.requestId,
          root: options.root, belloProfileDir: options.belloProfileDir,
          shopsProfileDir: options.shopsProfileDir, playwrightModulePath: options.playwrightModulePath,
          browserRead: true, onShopsTraffic: items => { lastTraffic = safeShopsTrafficSummary(items); },
          onReadDiagnostics: codes => { lastDiagnostics = safeReadDiagnostics(codes); } });
        lastResult = result.status;
        message = "照合結果をBELLOへ報告しました。BELLO画面で内容を確認してください。";
      } else if (action === "observe-start") {
        if (!options.manualObservation || manualSession || retainedSaveSession || privateSaveAttempted)
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
        if (!options.manualObservation || manualSession)
          throw Error("Exact-product private save is unavailable");
        if (privateSaveAttempted) {
          message = "この商品の保存操作は実行済み、または結果不明です。再実行できません。";
        } else {
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
        if (retainedSaveSession) throw Error("Shops browser is still open after save");
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
      const stage = error instanceof BridgeBoundaryError ?
        [error.phase, error.httpStatus ? `HTTP ${error.httpStatus}` : null, error.serverCode]
          .filter(Boolean).join(" / ") : null;
      message = form.get("action") === "save-private-once" && privateSaveAttempted ?
        "保存結果を確認できませんでした。再送せず、読取で確認してください。" :
        stage ? `処理を完了できませんでした（${stage}）。自動再試行はしていません。` :
        "処理を完了できませんでした。専用ブラウザのログイン状態と読取依頼を確認してください。";
    } finally { busy = false; }
    if (shutdown) {
      send(response, 200, "アプリを終了しました。", "text/plain; charset=utf-8");
      server.close();
    } else {
      response.writeHead(303, { Location: "/", "Cache-Control": "no-store" }); response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
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
  const app = await startDesktopApp(config, { openBrowser: showLocalBrowser });
  process.stdout.write(`BELLO local page: ${app.url}\n`);
}
