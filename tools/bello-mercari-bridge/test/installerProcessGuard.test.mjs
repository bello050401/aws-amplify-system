import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("installer blocks live bridge CLI and dedicated Chrome before replacing files", () => {
  if (process.platform !== "win32") return;
  const script = fileURLToPath(new URL("./installerProcessGuard.ps1", import.meta.url));
  const result = spawnSync("pwsh", ["-NoProfile", "-File", script], {
    encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /INSTALLER_PROCESS_GUARD_OK/);
});
