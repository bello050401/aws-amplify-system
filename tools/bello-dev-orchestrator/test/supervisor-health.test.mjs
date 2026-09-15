/**
 * QA-003: Windows supervisor (Start-BelloOrchestrator.ps1) のヘルス監視ロジックを
 * 合成 fixture で検証する。
 *
 * 実運用中の Orchestrator には一切触れない。ここで動かすのは:
 *   - Get-BelloHealthDecision  … 副作用の無い純粋な判定関数
 *   - Get-BelloDescendantProcessIds / Stop-BelloOrchestratorTree
 *     … 本物の (だが本番とは無関係の) 使い捨てデコイプロセスに対してのみ作用する
 *
 * 本体スクリプトから対象関数だけを AST で抜き出して読み込む。スクリプト全体を
 * dot-source すると mutex 取得や実際の Orchestrator 起動が走ってしまうため。
 *
 * Windows 以外ではこのスーパーバイザ自体が対象外なので skip する。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dirname, "..", "Start-BelloOrchestrator.ps1");
const isWindows = process.platform === "win32";

/** 対象スクリプトから、指定した関数定義だけをテキストとして抜き出す (実行はしない)。 */
function extractFunctions(names) {
  const escaped = SCRIPT_PATH.replace(/'/g, "''");
  const namesLiteral = names.map((n) => `'${n}'`).join(",");
  const psCommand = [
    // 既定のコンソール出力エンコード (日本語環境では CP932) だと、抽出したテキスト中の
    // 日本語コメントがパイプ経由で化ける。UTF-8 に固定してから出力する。
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false);",
    `$names = @(${namesLiteral});`,
    "$tokens = $null; $errors = $null;",
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors);`,
    "if ($errors.Count -gt 0) { throw ('parse errors: ' + ($errors -join '; ')) }",
    "$funcs = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $n.Name }, $true);",
    "if (@($funcs).Count -ne $names.Count) { throw ('found ' + @($funcs).Count + ' of ' + $names.Count + ' functions') }",
    "($funcs | ForEach-Object { $_.Extent.Text }) -join \"`n`n\"",
  ].join(" ");
  const res = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psCommand],
    { encoding: "utf8", timeout: 20000 },
  );
  if (res.status !== 0) {
    throw new Error(`関数の抽出に失敗しました: ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

/** 抜き出した関数定義 + テスト用スタブ + シナリオ本体を 1 本の .ps1 として実行し、JSON を受け取る。 */
function runHarness(functionsText, scenarioBody) {
  const tmpFile = path.join(os.tmpdir(), `bello-supervisor-health-${process.pid}-${Date.now()}.ps1`);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$script:Logs = New-Object System.Collections.Generic.List[string]",
    // 実際のログ書き込み (ファイル I/O・コンソール) はしない。呼ばれたことだけ記録する。
    "function Write-HostLog { param([Parameter(Mandatory)][string] $Message, [string] $Level = 'INFO') $script:Logs.Add(\"$Level|$Message\") }",
    functionsText,
    scenarioBody,
  ].join("\n\n");
  // BOM 無しで書くと、Windows PowerShell 5.1 は .ps1 をシステムの ANSI コードページ
  // (日本語環境では CP932) として読み、日本語コメントが化ける (このリポジトリで
  // 2026-09-03 に実際に起きた障害と同じ原因)。BOM を付けて確実に UTF-8 と認識させる。
  const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
  fs.writeFileSync(tmpFile, Buffer.concat([utf8Bom, Buffer.from(script, "utf8")]));
  try {
    const res = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", tmpFile],
      { encoding: "utf8", timeout: 30000 },
    );
    if (res.status !== 0) {
      throw new Error(`fixture 実行に失敗しました: ${res.stderr || res.stdout}`);
    }
    const marker = "###RESULT###";
    const idx = res.stdout.indexOf(marker);
    if (idx < 0) throw new Error(`結果マーカーが見つかりません: ${res.stdout}`);
    return JSON.parse(res.stdout.slice(idx + marker.length));
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

// -------------------------------------------------- Get-BelloHealthDecision
test(
  "Get-BelloHealthDecision: 単発失敗では動かず、連続失敗のみで復旧・起動猶予・明示停止を尊重する",
  { skip: !isWindows && "Windows 専用スーパーバイザのため対象外" },
  () => {
    const functionsText = extractFunctions(["Get-BelloHealthDecision"]);
    const scenario = `
$results = [ordered]@{}

# 1) 起動猶予中は判定しない (異常でもカウントしない)
$d = Get-BelloHealthDecision -HealthOk $false -UpSeconds 10 -StartupGraceSeconds 90 -FailureCount 0 -FailureThreshold 3 -StopFlagPresent $false
$results.grace = @{ action = $d.action; failureCount = $d.failureCount }

# 2) 正常なら常に action=ok, failureCount=0 にリセット
$d = Get-BelloHealthDecision -HealthOk $true -UpSeconds 999 -StartupGraceSeconds 90 -FailureCount 2 -FailureThreshold 3 -StopFlagPresent $false
$results.ok = @{ action = $d.action; failureCount = $d.failureCount }

# 3) 単発の失敗 (1回目) では復旧しない
$d = Get-BelloHealthDecision -HealthOk $false -UpSeconds 999 -StartupGraceSeconds 90 -FailureCount 0 -FailureThreshold 3 -StopFlagPresent $false
$results.singleFailure = @{ action = $d.action; failureCount = $d.failureCount }

# 4) しきい値の 1 つ手前ではまだ復旧しない
$d = Get-BelloHealthDecision -HealthOk $false -UpSeconds 999 -StartupGraceSeconds 90 -FailureCount 1 -FailureThreshold 3 -StopFlagPresent $false
$results.belowThreshold = @{ action = $d.action; failureCount = $d.failureCount }

# 5) しきい値に達したら復旧する
$d = Get-BelloHealthDecision -HealthOk $false -UpSeconds 999 -StartupGraceSeconds 90 -FailureCount 2 -FailureThreshold 3 -StopFlagPresent $false
$results.reachThreshold = @{ action = $d.action; failureCount = $d.failureCount }

# 6) しきい値に達していても、停止フラグがあれば復旧に回さない
$d = Get-BelloHealthDecision -HealthOk $false -UpSeconds 999 -StartupGraceSeconds 90 -FailureCount 2 -FailureThreshold 3 -StopFlagPresent $true
$results.deferToStop = @{ action = $d.action; failureCount = $d.failureCount }

Write-Output "###RESULT###"
Write-Output ($results | ConvertTo-Json -Depth 5 -Compress)
`;
    const r = runHarness(functionsText, scenario);

    assert.equal(r.grace.action, "skip");
    assert.equal(r.grace.failureCount, 0, "起動猶予中は失敗カウントを増やさない");

    assert.equal(r.ok.action, "ok");
    assert.equal(r.ok.failureCount, 0, "正常応答でカウントはリセットされる");

    assert.equal(r.singleFailure.action, "warn", "単発の失敗では復旧しない");
    assert.equal(r.singleFailure.failureCount, 1);

    assert.equal(r.belowThreshold.action, "warn");
    assert.equal(r.belowThreshold.failureCount, 2);

    assert.equal(r.reachThreshold.action, "recover", "連続失敗がしきい値に達したら復旧する");
    assert.equal(r.reachThreshold.failureCount, 3);

    assert.equal(r.deferToStop.action, "deferToStop", "停止フラグがあれば復旧より停止を優先する");
  },
);

// --------------------------------------------- Get-BelloDescendantProcessIds
test(
  "Get-BelloDescendantProcessIds: 子プロセスを見つける",
  { skip: !isWindows && "Windows 専用スーパーバイザのため対象外" },
  () => {
    const functionsText = extractFunctions(["Get-BelloDescendantProcessIds"]);
    const scenario = `
# cmd.exe が ping を子として同期実行する間だけ、親子関係が観測できる。
$parent = Start-Process -FilePath cmd.exe -ArgumentList '/c','ping -n 5 127.0.0.1 >NUL' -PassThru -WindowStyle Hidden
Start-Sleep -Milliseconds 800
try {
  $descendants = Get-BelloDescendantProcessIds -ParentId $parent.Id
  $result = @{ parentId = $parent.Id; descendantCount = @($descendants).Count }
} finally {
  try { Stop-Process -Id $parent.Id -Force -ErrorAction SilentlyContinue } catch {}
  foreach ($d in @($descendants)) { try { Stop-Process -Id $d -Force -ErrorAction SilentlyContinue } catch {} }
}
Write-Output "###RESULT###"
Write-Output ($result | ConvertTo-Json -Depth 5 -Compress)
`;
    const r = runHarness(functionsText, scenario);
    assert.ok(r.descendantCount >= 1, `ping.exe が子として見つかるはず (got ${r.descendantCount})`);
  },
);

// ------------------------------------------------- Stop-BelloOrchestratorTree
test(
  "Stop-BelloOrchestratorTree: コマンドライン不一致のプロセスは終了しない (PID 再利用対策)",
  { skip: !isWindows && "Windows 専用スーパーバイザのため対象外" },
  () => {
    const functionsText = extractFunctions(["Get-BelloDescendantProcessIds", "Stop-BelloOrchestratorTree"]);
    const scenario = `
$decoy = Start-Process -FilePath cmd.exe -ArgumentList '/c','ping -n 15 127.0.0.1 >NUL' -PassThru -WindowStyle Hidden
try {
  Start-Sleep -Milliseconds 300
  Stop-BelloOrchestratorTree -Proc $decoy -Reason 'test: cmdline mismatch'
  Start-Sleep -Milliseconds 300
  $alive = $null -ne (Get-Process -Id $decoy.Id -ErrorAction SilentlyContinue)
  $result = @{ alive = $alive }
} finally {
  # デコイは意図的に生かしたまま残す試験なので、後始末は自分で子孫ごと行う
  # (Stop-Process は子孫を巻き込まないため、放置すると ping.exe が孤児で残る)。
  foreach ($d in @(Get-BelloDescendantProcessIds -ParentId $decoy.Id)) { try { Stop-Process -Id $d -Force -ErrorAction SilentlyContinue } catch {} }
  try { Stop-Process -Id $decoy.Id -Force -ErrorAction SilentlyContinue } catch {}
}
Write-Output "###RESULT###"
Write-Output ($result | ConvertTo-Json -Depth 5 -Compress)
`;
    const r = runHarness(functionsText, scenario);
    assert.equal(r.alive, true, "コマンドラインが一致しないプロセスを誤って終了してはいけない");
  },
);

test(
  "Stop-BelloOrchestratorTree: 開始時刻が一致しないプロセスは終了しない (PID 再利用対策)",
  { skip: !isWindows && "Windows 専用スーパーバイザのため対象外" },
  () => {
    const functionsText = extractFunctions(["Get-BelloDescendantProcessIds", "Stop-BelloOrchestratorTree"]);
    // コマンドラインは一致させるが、StartTime を大きくずらして「別プロセスが同じ PID を再利用した」を模す。
    const scenario = `
$decoy = Start-Process -FilePath cmd.exe -ArgumentList '/c','echo cli.mjs start >NUL & ping -n 15 127.0.0.1 >NUL' -PassThru -WindowStyle Hidden
try {
  Start-Sleep -Milliseconds 300
  $fakeProc = [PSCustomObject]@{ Id = $decoy.Id; StartTime = $decoy.StartTime.AddSeconds(999) }
  Stop-BelloOrchestratorTree -Proc $fakeProc -Reason 'test: starttime mismatch'
  Start-Sleep -Milliseconds 300
  $alive = $null -ne (Get-Process -Id $decoy.Id -ErrorAction SilentlyContinue)
  $result = @{ alive = $alive }
} finally {
  foreach ($d in @(Get-BelloDescendantProcessIds -ParentId $decoy.Id)) { try { Stop-Process -Id $d -Force -ErrorAction SilentlyContinue } catch {} }
  try { Stop-Process -Id $decoy.Id -Force -ErrorAction SilentlyContinue } catch {}
}
Write-Output "###RESULT###"
Write-Output ($result | ConvertTo-Json -Depth 5 -Compress)
`;
    const r = runHarness(functionsText, scenario);
    assert.equal(r.alive, true, "開始時刻が一致しないプロセスを誤って終了してはいけない (PID 再利用の疑い)");
  },
);

test(
  "Stop-BelloOrchestratorTree: コマンドラインと開始時刻が一致すれば、子孫ごと終了する",
  { skip: !isWindows && "Windows 専用スーパーバイザのため対象外" },
  () => {
    const functionsText = extractFunctions(["Get-BelloDescendantProcessIds", "Stop-BelloOrchestratorTree"]);
    const scenario = `
$decoy = Start-Process -FilePath cmd.exe -ArgumentList '/c','echo cli.mjs start >NUL & ping -n 10 127.0.0.1 >NUL' -PassThru -WindowStyle Hidden
try {
  Start-Sleep -Milliseconds 800
  $descendantsBefore = Get-BelloDescendantProcessIds -ParentId $decoy.Id
  Stop-BelloOrchestratorTree -Proc $decoy -Reason 'test: matching kill'
  Start-Sleep -Milliseconds 500
  $parentAlive = $null -ne (Get-Process -Id $decoy.Id -ErrorAction SilentlyContinue)
  $descendantsAlive = @($descendantsBefore | Where-Object { $null -ne (Get-Process -Id $_ -ErrorAction SilentlyContinue) })
  $result = @{
    descendantCountBefore = @($descendantsBefore).Count
    parentAlive = $parentAlive
    descendantsStillAlive = @($descendantsAlive).Count
  }
} finally {
  try { Stop-Process -Id $decoy.Id -Force -ErrorAction SilentlyContinue } catch {}
  foreach ($d in @($descendantsBefore)) { try { Stop-Process -Id $d -Force -ErrorAction SilentlyContinue } catch {} }
}
Write-Output "###RESULT###"
Write-Output ($result | ConvertTo-Json -Depth 5 -Compress)
`;
    const r = runHarness(functionsText, scenario);
    assert.ok(r.descendantCountBefore >= 1, "ping.exe が子として見つかるはず");
    assert.equal(r.parentAlive, false, "一致するデコイは終了されるはず");
    assert.equal(r.descendantsStillAlive, 0, "子孫プロセスも孤児化させず終了するはず");
  },
);

// -------------------------------------- Test-BelloOrchestratorHealth (P1 修正)
/**
 * QA-003 追加修正 (P1): PowerShell 5.1 では ProcessStartInfo.ArgumentList が
 * $null のままで (.NET Framework 4.7.2 未満)、旧実装の $psi.ArgumentList.Add(...)
 * が「Null 値の式でメソッドを呼び出すことはできません」で例外になり、
 * Test-BelloOrchestratorHealth は正常なサーバーでも常に ok:false を返していた
 * (監督実測: PSVersion 5.1.19041.6456, ArgumentList=$null)。
 *
 * ここでは実関数 (AST 抜き出し・実行はモック無し) を powershell.exe 上で動かし、
 * 空白を含む一時パスに置いたダミー CLI に対して:
 *   1. 終了コード 0 (正常)     -> ok:true
 *   2. 終了コード 非0 (異常)   -> ok:false, reason に情報が残る
 *   3. 無応答 (ハング)         -> 有限時間で ok:false (プロセスは Kill される)
 * の 3 パターンを検証する。CliPath の引用符処理も込みで確認するため、
 * 一時ディレクトリ名にわざと空白を混ぜる。
 */
test(
  "Test-BelloOrchestratorHealth: PS5.1 (ArgumentList=$null) でも空白を含むCLIパスを安全に実行し、終了0/非0/無応答を正しく判定する",
  { skip: !isWindows && "Windows 専用スーパーバイザのため対象外" },
  () => {
    // 監督実測どおり、この実行環境の ArgumentList が本当に $null かどうかも記録する
    // (再現できていない状態で「直った」と誤認しないため)。
    const probe = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[bool]((New-Object System.Diagnostics.ProcessStartInfo).ArgumentList)",
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    const psVersionProbe = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"],
      { encoding: "utf8", timeout: 10000 },
    );

    const functionsText = extractFunctions([
      "ConvertTo-BelloQuotedArgument",
      "ConvertTo-BelloArgumentString",
      "Test-BelloOrchestratorHealth",
    ]);

    // 空白を含む一時ディレクトリにダミー CLI (node スクリプト) を 3 本置く。
    // 監督が呼ぶ実引数は固定 (health-check --json --timeout-ms N) なので、
    // 「どう振る舞うか」はスクリプトの中身 (ファイル自体) で分ける。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bello ps5.1 health "));
    const okCli = path.join(dir, "dummy cli ok.mjs");
    const failCli = path.join(dir, "dummy cli fail.mjs");
    const hangCli = path.join(dir, "dummy cli hang.mjs");
    fs.writeFileSync(okCli, "process.exit(0);\n", "utf8");
    fs.writeFileSync(failCli, 'process.stdout.write("dummy failure reason");\nprocess.exit(7);\n', "utf8");
    // 応答しない (無出力・無終了) を模す。イベントループを生かしたまま何もしない。
    fs.writeFileSync(hangCli, "setInterval(() => {}, 60000);\n", "utf8");

    try {
      const nodeExe = process.execPath; // 実際に動く node.exe (このテスト自身の実行環境)

      const scenarioFor = (cliPath, timeoutMs) => `
$health = Test-BelloOrchestratorHealth -NodeExe '${nodeExe.replace(/'/g, "''")}' -CliPath '${cliPath.replace(/'/g, "''")}' -TimeoutMs ${timeoutMs}
Write-Output "###RESULT###"
Write-Output ($health | ConvertTo-Json -Depth 5 -Compress)
`;

      const okStart = Date.now();
      const ok = runHarness(functionsText, scenarioFor(okCli, 3000));
      const okElapsed = Date.now() - okStart;
      assert.equal(ok.ok, true, `終了コード0は ok:true になるはず (got ${JSON.stringify(ok)})`);
      assert.ok(okElapsed < 3000, `正常時は即座に戻るはず (${okElapsed}ms)`);

      const fail = runHarness(functionsText, scenarioFor(failCli, 3000));
      assert.equal(fail.ok, false, "終了コード非0は ok:false になるはず");
      assert.ok(fail.reason && fail.reason.length > 0, "非0終了の理由が空であってはいけない");

      const hangStart = Date.now();
      const hang = runHarness(functionsText, scenarioFor(hangCli, 500));
      const hangElapsed = Date.now() - hangStart;
      assert.equal(hang.ok, false, "無応答は ok:false になるはず");
      // hardLimitMs = TimeoutMs(500) + 5000。監督プロセスがハングし続けないことの直接的な証拠。
      assert.ok(hangElapsed < 15000, `無応答でも有限時間で戻るはず (${hangElapsed}ms)`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    // 実測記録: この環境で ArgumentList が $null だったか (監督報告との突き合わせ用)。
    console.log(
      `[Test-BelloOrchestratorHealth] PSVersion=${(psVersionProbe.stdout || "").trim()} ArgumentList-is-null=${(probe.stdout || "").trim() === "False"}`,
    );
  },
);
