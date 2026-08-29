#!/usr/bin/env node
/**
 * Test-only runner for scripts that need to import "server-only"-marked
 * modules (lib/inventory/zaicoSync.ts, zaicoSyncPorts.ts, history.ts,
 * etc.) from plain Node instead of from inside Next.js.
 *
 * The "server-only" package (node_modules/server-only/index.js)
 * unconditionally `throw`s when its main entry point is loaded via a
 * normal CJS `require` — it only resolves to its no-op `empty.js` when
 * the *consumer* (webpack/Next.js, via the package's "react-server"
 * export condition) requests that condition explicitly. Outside of
 * Next.js's own bundler there is no clean, non-invasive way to make Node
 * pick that alternate export condition just for this one package without
 * also changing how `react`/`next/headers` resolve (tried and confirmed
 * broken — using `--conditions=react-server` globally makes `next/headers`
 * pull in React's `react-server` subset, which itself refuses to load
 * outside an actual RSC runtime).
 *
 * So: this script temporarily overwrites the installed
 * node_modules/server-only/index.js with a no-op module, runs the target
 * script under tsx, and restores the original file content afterward —
 * in a try/finally, so a crash or an assertion failure in the target
 * script still restores the real file before this process exits. This
 * only ever touches an (untracked, gitignored) node_modules file for the
 * duration of one local verification run; it changes nothing about how
 * `next build`/`next dev`/the deployed app behave.
 *
 * Usage: node scripts/with-server-only-stub.cjs <script.ts> [args...]
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const target = process.argv[2];
if (!target) {
  console.error("Usage: node scripts/with-server-only-stub.cjs <script.ts> [args...]");
  process.exit(1);
}

const serverOnlyIndexPath = path.join(__dirname, "..", "node_modules", "server-only", "index.js");
const original = fs.readFileSync(serverOnlyIndexPath, "utf8");

let exitCode = 1;
try {
  fs.writeFileSync(serverOnlyIndexPath, "module.exports = {};\n");
  const tsxCliPath = path.join(__dirname, "..", "node_modules", "tsx", "dist", "cli.mjs");
  const result = spawnSync(process.execPath, [tsxCliPath, target, ...process.argv.slice(3)], {
    stdio: "inherit",
    cwd: path.join(__dirname, ".."),
  });
  exitCode = result.status ?? 1;
} finally {
  fs.writeFileSync(serverOnlyIndexPath, original);
}
process.exit(exitCode);
