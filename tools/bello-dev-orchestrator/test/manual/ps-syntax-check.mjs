/**
 * PowerShell スクリプトの構文だけを検査する (実行はしない)。
 * Language.Parser::ParseFile は AST を組み立てるだけで、スクリプトの中身は一切実行しない。
 *
 * 使い方: node test/manual/ps-syntax-check.mjs <script.ps1> [<script2.ps1> ...]
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("使い方: node test/manual/ps-syntax-check.mjs <script.ps1> ...");
  process.exit(2);
}

let failed = false;
for (const target of targets) {
  const abs = path.resolve(target);
  const escaped = abs.replace(/'/g, "''");
  const psCommand = [
    "$errors = $null;",
    `[System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$null, [ref]$errors) | Out-Null;`,
    "if ($errors.Count -gt 0) {",
    "  foreach ($e in $errors) { Write-Output ('ERR: ' + $e.Message + ' @ line ' + $e.Extent.StartLineNumber) }",
    "  exit 1",
    "} else {",
    "  Write-Output 'SYNTAX_OK';",
    "  exit 0",
    "}",
  ].join(" ");

  const res = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psCommand],
    { encoding: "utf8" },
  );
  console.log(`--- ${target} ---`);
  console.log(String(res.stdout || "").trim());
  if (res.stderr && res.stderr.trim()) console.error(String(res.stderr).trim());
  if (res.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
