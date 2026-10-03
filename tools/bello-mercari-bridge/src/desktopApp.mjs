import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openBelloAdminContext, validBelloOrigin } from "./belloSession.mjs";
import { openDedicatedLogin } from "./session.mjs";
import { runBelloCloudReadOnce } from "./cloudConnector.mjs";

const HASH = /^[a-f0-9]{64}$/;
const html = (value) => String(value).replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);
const here = dirname(fileURLToPath(import.meta.url));

function optionsOf(config) {
  const localAppData = process.env.LOCALAPPDATA;
  const dataDir = config?.dataDir ?? (localAppData && join(localAppData, "BELLO", "MercariBridge"));
  if (!validBelloOrigin(config?.origin) || !HASH.test(config?.requestId) ||
      !dataDir || !isAbsolute(dataDir)) throw Error("Invalid BELLO desktop configuration");
  return { origin: config.origin, requestId: config.requestId, dataDir,
    root: join(dataDir, "Queue"), belloProfileDir: join(dataDir, "BELLOChrome"),
    shopsProfileDir: join(dataDir, "ShopsChrome"),
    playwrightModulePath: join(here, "..", "node_modules", "playwright", "package.json") };
}

function page({ csrf, options, message, busy, belloOpen, shopsOpen, lastResult }) {
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
${lastResult ? `<p>直近の結果: <strong>${html(lastResult)}</strong>。出品完了の確認ではありません。</p>` : ""}</section>
<section><h2>3. BELLOで結果を見る</h2><p>照合後、BELLOの照合依頼画面で「照合結果を確認する」を押してください。</p>
<p><a href="${html(options.origin)}/inventory/mercari-bridge?requestId=${html(options.requestId)}" target="_blank" rel="noopener noreferrer">BELLOの照合依頼画面を開く</a></p>
${button("shutdown", "このアプリを終了")}</section>
</main></body></html>`;
}

const send = (response, status, content, contentType = "text/html; charset=utf-8") => {
  response.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" });
  response.end(content);
};

/** Visible loopback UI. Every read is a deliberate click bound to one configured request ID. */
export async function startDesktopApp(config, {
  openBello = openBelloAdminContext, openShops = openDedicatedLogin,
  runRead = runBelloCloudReadOnce, openBrowser = null,
} = {}) {
  const options = optionsOf(config);
  const csrf = randomBytes(32).toString("hex");
  let busy = false;
  let message = "";
  let lastResult = "";
  let belloContext = null;
  let shopsContext = null;
  let localOrigin;
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      send(response, 200, page({ csrf, options, message, busy,
        belloOpen: Boolean(belloContext), shopsOpen: Boolean(shopsContext), lastResult }));
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
        if (shopsContext) throw Error("Shops browser already open");
        shopsContext = await openShops({ profileDir: options.shopsProfileDir,
          playwrightModulePath: options.playwrightModulePath });
        shopsContext.once("close", () => { shopsContext = null; });
        message = "Shopsの専用ブラウザを開きました。通常ログイン後、ブラウザを閉じてください。";
      } else if (action === "read") {
        if (belloContext) { await belloContext.close(); belloContext = null; }
        if (shopsContext) { await shopsContext.close(); shopsContext = null; }
        const result = await runRead({ origin: options.origin, requestId: options.requestId,
          root: options.root, belloProfileDir: options.belloProfileDir,
          shopsProfileDir: options.shopsProfileDir, playwrightModulePath: options.playwrightModulePath,
          browserRead: true });
        lastResult = result.status;
        message = "照合結果をBELLOへ報告しました。BELLO画面で内容を確認してください。";
      } else if (action === "shutdown") {
        if (belloContext) { await belloContext.close(); belloContext = null; }
        if (shopsContext) { await shopsContext.close(); shopsContext = null; }
        shutdown = true;
      } else throw Error("Unknown action");
    } catch {
      message = "処理を完了できませんでした。専用ブラウザのログイン状態と読取依頼を確認してください。";
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
      await new Promise(resolve => server.close(resolve));
      throw Error("Could not open the BELLO desktop window");
    }
  }
  return { url: localOrigin, close: async () => {
    if (belloContext) await belloContext.close();
    if (shopsContext) await shopsContext.close();
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
  await startDesktopApp(config, { openBrowser: showLocalBrowser });
}
