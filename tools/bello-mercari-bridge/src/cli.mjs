import { readFile } from "node:fs/promises";
import { enqueueExistingRead, listReadResults } from "./queue.mjs";
import { runExistingRead } from "./readWorker.mjs";
import { openDedicatedLogin, openExistingProductReadSession } from "./session.mjs";
import { createExistingProductReader } from "./existingProductReader.mjs";
import { openBelloAdminContext } from "./belloSession.mjs";
import { runBelloCloudReadOnce } from "./cloudConnector.mjs";
import { exportSavedDirectReadProof } from "./exportDirectReadProof.mjs";

function argsOf(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i]?.startsWith("--") || !rest[i + 1]) throw Error("Use --name value arguments");
    flags[rest[i].slice(2)] = rest[i + 1];
  }
  return { command, flags };
}

async function main() {
  const { command, flags } = argsOf(process.argv.slice(2));
  if (command === "export-saved-direct-read-proof") {
    await exportSavedDirectReadProof({ configPath: flags.config, outputPath: flags.out });
    process.stdout.write("BELLOへ読み込む読取記録ファイルを書き出しました。Shopsへの通信は行っていません。\n");
    return;
  }
  if (command === "open-bello-login") {
    const context = await openBelloAdminContext({ origin: flags["bello-origin"],
      profileDir: flags["bello-profile"], playwrightModulePath: flags.playwright,
      navigateToLogin: true });
    process.stdout.write("BELLOの管理者ログイン画面を開きました。本人が通常ログインし、作業後に閉じてください。\n");
    await new Promise(resolve => context.once("close", resolve));
    return;
  }
  if (command === "run-cloud-read") {
    if (flags["browser-read"] === "yes" && !flags["shops-profile"])
      throw Error("--shops-profile is required for the opt-in browser read");
    const result = await runBelloCloudReadOnce({ origin: flags["bello-origin"],
      requestId: flags.request, root: flags.root, belloProfileDir: flags["bello-profile"],
      shopsProfileDir: flags["shops-profile"], playwrightModulePath: flags.playwright,
      browserRead: flags["browser-read"] === "yes" });
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  if (command === "open-login") {
    const context = await openDedicatedLogin({ profileDir: flags.profile, playwrightModulePath: flags.playwright });
    process.stdout.write("専用ブラウザを開きました。通常のログインを行い、作業後にブラウザを閉じてください。\n");
    await new Promise(resolve => context.once("close", resolve));
    return;
  }
  if (command === "open-existing") {
    const { context, state } = await openExistingProductReadSession({ root: flags.root, profileDir: flags.profile,
      playwrightModulePath: flags.playwright, shopId: flags.shop, remoteId: flags.remote });
    process.stdout.write(JSON.stringify({ state, remoteId: flags.remote }) + "\n");
    await new Promise(resolve => context.once("close", resolve));
    return;
  }
  if (!flags.root || !flags.account) throw Error("--root and --account are required");
  if (command === "enqueue-read") {
    if (!flags.expected) throw Error("--expected must name a local JSON snapshot");
    const expectedFields = JSON.parse(await readFile(flags.expected, "utf8"));
    const job = await enqueueExistingRead(flags.root, {
      accountReference: flags.account, inventoryCode: flags.sku,
      remoteId: flags.remote, expectedFields,
    });
    process.stdout.write(JSON.stringify({ jobId: job.jobId, operation: job.operation }) + "\n");
    return;
  }
  if (command === "run-read") {
    const reader = flags["browser-read"] === "yes" ? createExistingProductReader({
      root: flags.root, profileDir: flags.profile, playwrightModulePath: flags.playwright,
      shopId: flags.account,
    }) : null;
    const result = await runExistingRead(flags.root, flags.account, flags.job, reader);
    process.stdout.write(JSON.stringify({ jobId: result.jobId, status: result.status, reasonCode: result.reasonCode }) + "\n");
    return;
  }
  if (command === "results") {
    const results = await listReadResults(flags.root, flags.job);
    process.stdout.write(JSON.stringify(results.map(({ recordedAt, status, reasonCode }) => ({ recordedAt, status, reasonCode }))) + "\n");
    return;
  }
  throw Error("Commands: export-saved-direct-read-proof, open-bello-login, run-cloud-read, open-login, open-existing, enqueue-read, run-read, results");
}

main().catch(error => {
  process.stderr.write(`BELLO Mercari bridge: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
