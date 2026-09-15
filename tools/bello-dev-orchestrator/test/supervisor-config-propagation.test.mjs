/**
 * QA-003 追加修正 P2: Start-BelloOrchestrator.ps1 の -ConfigPath が、
 * 子の `node cli.mjs start` と Test-BelloOrchestratorHealth の
 * `node cli.mjs health-check` の両方に、監督プロセス自身が使うのと
 * 同じ値で伝わることを検証する。
 *
 * 実環境の既定ポート (4319) や既定 dataRoot には一切触れない:
 *   - 監督スクリプト自体を一時ディレクトリへコピーし、そこに専用の
 *     bello-orchestrator.config.json を置く (既定パスの解決先ごと隔離する)。
 *   - 子プロセスは実際の cli.mjs ではなく、argv と env を記録して終了する
 *     テスト用ダミー CLI (.mjs) を使う。
 *   - $env:BELLO_TEST_NO_RUN を立てて監督スクリプトをドットソースし、
 *     Mutex 取得・監督ループ・exit を実行させない
 *     (関数定義と、ConfigPath 解決までの変数だけを読み込む)。
 *
 * Windows 以外ではこの監督スクリプト自体が対象外なので skip する。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_SRC = path.resolve(__dirname, "..", "Start-BelloOrchestrator.ps1");
const isWindows = process.platform === "win32";
const NODE_EXE = process.execPath; // このテスト自身が動いている実 node.exe

/** UTF-8 BOM 付きで書く。Windows PowerShell 5.1 は BOM 無しの .ps1 を
 *  システムの ANSI コードページとして読み、日本語コメントが化けて構文エラーになる
 *  (このリポジトリで実際に踏んだ不具合と同じ原因)。 */
function writeUtf8BomFile(p, text) {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  fs.writeFileSync(p, Buffer.concat([bom, Buffer.from(text, "utf8")]));
}

function writeUtf8File(p, text) {
  fs.writeFileSync(p, text, "utf8");
}

/** argv と env.BELLO_ORCHESTRATOR_CONFIG を JSON ファイルへ記録して終了するダミー CLI。 */
function dummyCliSource(outFile) {
  const escapedOut = JSON.stringify(outFile);
  return [
    "import fs from 'node:fs';",
    `fs.writeFileSync(${escapedOut}, JSON.stringify({`,
    "  argv: process.argv.slice(2),",
    "  env: process.env.BELLO_ORCHESTRATOR_CONFIG ?? null,",
    "}), 'utf8');",
    "process.exit(0);",
  ].join("\n");
}

/** 監督スクリプトの一部 (ConfigPath 解決 + 関数定義) をドットソースし、
 *  変数・関数を使って続きのシナリオを実行、JSON で結果を受け取る。 */
function runHarness({ scriptDir, configPathArg, scenarioBody }) {
  const scriptPath = path.join(scriptDir, "Start-BelloOrchestrator.ps1");
  const tmpFile = path.join(os.tmpdir(), `bello-config-prop-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  const configArgLine = configPathArg ? `-ConfigPath '${configPathArg.replace(/'/g, "''")}'` : "";
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "$env:BELLO_TEST_NO_RUN = '1'",
    `. '${scriptPath.replace(/'/g, "''")}' ${configArgLine}`,
    scenarioBody,
  ].join("\n");
  writeUtf8BomFile(tmpFile, script);
  try {
    const res = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", tmpFile],
      { encoding: "utf8", timeout: 30000 },
    );
    if (res.status !== 0) {
      throw new Error(`harness 実行に失敗しました (exit ${res.status}): ${res.stderr || res.stdout}`);
    }
    const marker = "###RESULT###";
    const idx = res.stdout.indexOf(marker);
    if (idx < 0) throw new Error(`結果マーカーが見つかりません: stdout=${res.stdout} stderr=${res.stderr}`);
    return JSON.parse(res.stdout.slice(idx + marker.length));
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

let baseDir;
const cliDirsToClean = [];
test.before(() => {
  if (!isWindows) return;
  // わざと空白と日本語を混ぜたパスにする (指示: 空白/日本語パス互換の確認)。
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "bello 設定伝搬 テスト "));
  fs.copyFileSync(SCRIPT_SRC, path.join(baseDir, "Start-BelloOrchestrator.ps1"));
});

test.after(() => {
  if (baseDir) fs.rmSync(baseDir, { recursive: true, force: true });
  for (const d of cliDirsToClean) fs.rmSync(d, { recursive: true, force: true });
});

test(
  "既定設定 (ConfigPath省略): Mutex名は変更前と完全に同じ 'Local\\BELLO-DevOrchestrator' のまま",
  { skip: !isWindows && "Windows 専用スーパーバイザのため対象外" },
  () => {
    const dataRoot = path.join(baseDir, "既定 data");
    writeUtf8File(
      path.join(baseDir, "bello-orchestrator.config.json"),
      JSON.stringify({ dataRoot }),
    );
    const scenario = `
$mutexName = Get-BelloMutexName -ResolvedConfigPath $ResolvedConfigPath -IsDefaultConfig $IsDefaultConfig
$out = @{
  isDefault = $IsDefaultConfig
  resolvedConfigPath = $ResolvedConfigPath
  envConfig = $env:BELLO_ORCHESTRATOR_CONFIG
  dataRoot = $dataRoot
  mutexName = $mutexName
}
Write-Output "###RESULT###"
Write-Output ($out | ConvertTo-Json -Depth 5 -Compress)
`;
    const r = runHarness({ scriptDir: baseDir, configPathArg: null, scenarioBody: scenario });

    assert.equal(r.isDefault, true, "既定パスは IsDefaultConfig=true と判定されるはず");
    assert.equal(r.mutexName, "Local\\BELLO-DevOrchestrator", "既定設定の Mutex 名は変更前と完全一致するはず (常駐タスクの互換性)");
    assert.equal(r.envConfig, r.resolvedConfigPath, "起動先 (env) は監督プロセス自身の ConfigPath と一致するはず");
    assert.equal(path.resolve(r.dataRoot), path.resolve(dataRoot), "state 先 (dataRoot) は設定ファイルの値と一致するはず");
  },
);

test(
  "別設定 (空白/日本語パス): 起動先(env)・probe先(env)・state先(dataRoot)が必ず一致し、Mutex名は既定と異なる",
  { skip: !isWindows && "Windows 専用スーパーバイザのため対象外" },
  () => {
    // ConfigPath 自体は空白/日本語混じり (env 経由で渡すので引用符規則の影響を受けないはず)。
    const cfgDir = path.join(baseDir, "隔離 設定 A");
    fs.mkdirSync(cfgDir, { recursive: true });
    const configPath = path.join(cfgDir, "config.json");
    const dataRoot = path.join(cfgDir, "data");
    writeUtf8File(configPath, JSON.stringify({ dataRoot }));

    // 本体起動にも実際の関数を使い、空白と日本語を含むインストール先を検証する。
    const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), "bello CLI 日本語 path "));
    cliDirsToClean.push(cliDir);

    const startOut = path.join(cliDir, "start-recorded.json");
    const healthOut = path.join(cliDir, "health-recorded.json");
    fs.writeFileSync(path.join(cliDir, "dummy-start-cli.mjs"), dummyCliSource(startOut), "utf8");
    fs.writeFileSync(path.join(cliDir, "dummy-health-cli.mjs"), dummyCliSource(healthOut), "utf8");

    const scenario = `
$mutexName = Get-BelloMutexName -ResolvedConfigPath $ResolvedConfigPath -IsDefaultConfig $IsDefaultConfig

# 実スクリプトと同じ形: Start-Process は $env:BELLO_ORCHESTRATOR_CONFIG を継承する。
$startCli = Join-Path '${cliDir.replace(/'/g, "''")}' 'dummy-start-cli.mjs'
$child = Start-BelloNodeService -NodeExe '${NODE_EXE.replace(/'/g, "''")}' -CliPath $startCli -WorkingDirectory '${cliDir.replace(/'/g, "''")}'
if (-not $child.WaitForExit(10000)) { $child.Kill(); throw 'dummy start timed out' }
if ($child.ExitCode -ne 0) { throw 'dummy start failed' }

$healthCli = Join-Path '${cliDir.replace(/'/g, "''")}' 'dummy-health-cli.mjs'
$health = Test-BelloOrchestratorHealth -NodeExe '${NODE_EXE.replace(/'/g, "''")}' -CliPath $healthCli -TimeoutMs 5000 -ConfigPath $ResolvedConfigPath

$out = @{
  isDefault = $IsDefaultConfig
  resolvedConfigPath = $ResolvedConfigPath
  dataRoot = $dataRoot
  mutexName = $mutexName
  healthOk = $health.ok
}
Write-Output "###RESULT###"
Write-Output ($out | ConvertTo-Json -Depth 5 -Compress)
`;
    const r = runHarness({ scriptDir: baseDir, configPathArg: configPath, scenarioBody: scenario });

    assert.equal(r.isDefault, false, "別設定は IsDefaultConfig=false と判定されるはず");
    assert.notEqual(r.mutexName, "Local\\BELLO-DevOrchestrator", "別設定は既定 Mutex 名を名乗ってはいけない (でないと二重起動扱いで黙って exit 0 する)");
    assert.ok(r.mutexName.startsWith("Local\\BELLO-DevOrchestrator-"), "別設定の Mutex 名は既定名 + 識別子の形のはず");
    assert.equal(r.healthOk, true, "ダミー health-check (exit 0) は ok:true を返すはず");
    assert.equal(path.resolve(r.dataRoot), path.resolve(dataRoot), "state 先は設定ファイルの dataRoot と一致するはず");

    // ---- ここが本題: 起動先・probe先・state先が同じ ConfigPath に揃っているか ----
    const started = JSON.parse(fs.readFileSync(startOut, "utf8"));
    const healthed = JSON.parse(fs.readFileSync(healthOut, "utf8"));

    // process.argv.slice(2) は node exe とスクリプト自身のパス (= dummy CLI パス) を
    // 落とした残りなので、ここには含まれない ("start" "--watchdog" の2つだけ)。
    assert.deepEqual(
      started.argv,
      ["start", "--watchdog"],
      "start への引数は変更前と同じ形 (--config は増やさない) のはず",
    );
    assert.equal(started.env, r.resolvedConfigPath, "起動先 (start の env) は監督プロセスの ConfigPath と完全一致するはず (空白/日本語パスも含め)");

    assert.equal(healthed.argv[0], "health-check", "health-check への引数は変更前と同じ形のはず");
    assert.equal(healthed.env, r.resolvedConfigPath, "probe先 (health-check の env) は監督プロセスの ConfigPath と完全一致するはず");

    assert.equal(started.env, healthed.env, "起動先と probe先が食い違ってはいけない");
    assert.equal(started.env, path.resolve(configPath), "起動先/probe先は、渡した ConfigPath (空白/日本語混じり) そのものと一致するはず");
  },
);

test(
  "別設定どうし: 異なる設定は別々の Mutex 名になり (隔離)、同じ設定を指せば同じ Mutex 名になる (単一起動は維持)",
  { skip: !isWindows && "Windows 専用スーパーバイザのため対象外" },
  () => {
    const dirA = path.join(baseDir, "設定B-1");
    const dirB = path.join(baseDir, "設定B-2");
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    const configA = path.join(dirA, "config.json");
    const configB = path.join(dirB, "config.json");
    writeUtf8File(configA, JSON.stringify({ dataRoot: path.join(dirA, "data") }));
    writeUtf8File(configB, JSON.stringify({ dataRoot: path.join(dirB, "data") }));

    const scenario = `
$out = @{ mutexName = (Get-BelloMutexName -ResolvedConfigPath $ResolvedConfigPath -IsDefaultConfig $IsDefaultConfig) }
Write-Output "###RESULT###"
Write-Output ($out | ConvertTo-Json -Depth 5 -Compress)
`;
    const rA1 = runHarness({ scriptDir: baseDir, configPathArg: configA, scenarioBody: scenario });
    const rA2 = runHarness({ scriptDir: baseDir, configPathArg: configA, scenarioBody: scenario });
    const rB = runHarness({ scriptDir: baseDir, configPathArg: configB, scenarioBody: scenario });

    assert.equal(rA1.mutexName, rA2.mutexName, "同じ ConfigPath なら常に同じ Mutex 名 (同じ設定の二重起動は防ぐ)");
    assert.notEqual(rA1.mutexName, rB.mutexName, "異なる ConfigPath なら異なる Mutex 名 (別設定どうしは互いをブロックしない)");
  },
);

test('dashboard disabled: supervisor disables HTTP recovery, default enables it', { skip: !isWindows }, () => {
  for (const enabled of [false, true]) {
    const configPath = path.join(baseDir, `dashboard-${enabled}.json`);
    writeUtf8File(configPath, JSON.stringify({ dataRoot: path.join(baseDir, `data-${enabled}`), dashboard: { enabled } }));
    const result = runHarness({ scriptDir: baseDir, configPathArg: configPath, scenarioBody: `
Write-Output '###RESULT###'
Write-Output (@{ enabled = $HealthMonitoringEnabled } | ConvertTo-Json -Compress)
` });
    assert.equal(result.enabled, enabled);
  }
});
