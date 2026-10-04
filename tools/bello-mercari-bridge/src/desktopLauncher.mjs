import { spawn, execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const OPEN_URI = "bello-mercari-bridge://open";
export const CONTROL_URL = "http://127.0.0.1:56210/";
const CONTROL_PORT = 56210;
const sourceDir = dirname(fileURLToPath(import.meta.url));
const configPath = join(sourceDir, "..", "..", "config.json");

function launchError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export async function probeControl(fetchFn = fetch) {
  let response;
  try {
    response = await fetchFn(CONTROL_URL, {
      redirect: "manual", signal: AbortSignal.timeout(1500),
    });
  } catch { return "ABSENT"; }
  if (response.status !== 200 || !response.headers.get("content-type")?.startsWith("text/html"))
    return "OTHER_SERVICE";
  const reader = response.body?.getReader();
  if (!reader) return "OTHER_SERVICE";
  let size = 0;
  const parts = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) return "OTHER_SERVICE";
      parts.push(value);
    }
  } catch { return "OTHER_SERVICE"; }
  finally { await reader.cancel().catch(() => {}); }
  const html = Buffer.concat(parts).toString("utf8");
  return html.includes("<title>BELLO メルカリ照合</title>") &&
    html.includes("<h1>BELLO メルカリShops既存商品照合</h1>") &&
    html.includes('name="csrf"') ? "AVAILABLE" : "OTHER_SERVICE";
}

export async function findRunningBridge() {
  const command = '$ErrorActionPreference = "Stop"; $count = 0; ' +
    'foreach ($process in (Get-CimInstance Win32_Process -Filter "Name = \'node.exe\' OR Name = \'nodew.exe\'")) { ' +
    'if ([string]::IsNullOrWhiteSpace($process.CommandLine)) { throw "PROCESS_CHECK_FAILED" }; ' +
    'if ($process.CommandLine -match "desktopApp\\.mjs") { $count++ } }; $count';
  const output = await new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
      { windowsHide: true, timeout: 5000 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
  });
  const count = Number(output);
  if (!Number.isSafeInteger(count) || count < 0) throw launchError("PROCESS_CHECK_FAILED");
  return count > 0;
}

async function startBridge() {
  let config;
  try { config = JSON.parse(await readFile(configPath, "utf8")); }
  catch { throw launchError("NOT_INSTALLED"); }
  if (config.controlPort !== CONTROL_PORT) throw launchError("NOT_INSTALLED");
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath,
      [join(sourceDir, "desktopApp.mjs"), "--config", configPath], {
        detached: true, stdio: "ignore", windowsHide: true,
        env: { ...process.env, BELLO_MERCARI_PROTOCOL_LAUNCH: "1" },
      });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

async function openControlPage() {
  await new Promise((resolve, reject) => {
    const child = spawn("explorer.exe", [CONTROL_URL], {
      detached: true, stdio: "ignore", windowsHide: false,
    });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

export async function openPcControlOnce(uri, {
  probe = probeControl, findRunning = findRunningBridge,
  start = startBridge, open = openControlPage,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (uri !== OPEN_URI) throw launchError("INVALID_URI");
  const state = await probe();
  if (state === "AVAILABLE") { await open(); return "EXISTING"; }
  if (state !== "ABSENT") throw launchError("PORT_OCCUPIED");
  let running;
  try { running = await findRunning(); }
  catch { throw launchError("PROCESS_CHECK_FAILED"); }
  if (running) throw launchError("ALREADY_RUNNING");
  await start();
  for (let attempt = 0; attempt < 40; attempt++) {
    await wait(250);
    const next = await probe();
    if (next === "AVAILABLE") { await open(); return "STARTED"; }
    if (next !== "ABSENT") throw launchError("PORT_OCCUPIED");
  }
  throw launchError("START_FAILED");
}

async function showLaunchError(error) {
  const message = error?.code === "ALREADY_RUNNING" ?
    "BELLOのPCアプリがすでに動いています。開いているPCアプリの画面をご確認ください。" :
    error?.code === "NOT_INSTALLED" ?
      "BELLOのPCアプリの更新が必要です。インストーラーを実行してください。" :
      "BELLOのPCアプリを開けませんでした。デスクトップの「BELLO メルカリ照合」から起動してください。";
  await new Promise(resolve => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
      "-Command", `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${message}', 'BELLO メルカリ照合') | Out-Null`],
    { windowsHide: true, timeout: 30000 }, () => resolve());
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
  try { await openPcControlOnce(process.argv.length === 3 ? process.argv[2] : null); }
  catch (error) { await showLaunchError(error); process.exitCode = 1; }
}
