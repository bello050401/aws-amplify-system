import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { enqueueExistingRead, listReadResults } from "./queue.mjs";
import { runExistingRead } from "./readWorker.mjs";
import { openDedicatedLogin, openExistingProductReadSession } from "./session.mjs";
import { createExistingProductReader } from "./existingProductReader.mjs";
import { openBelloAdminContext } from "./belloSession.mjs";
import { runBelloCloudReadOnce } from "./cloudConnector.mjs";
import { exportSavedDirectReadProof } from "./exportDirectReadProof.mjs";
import { CREATE_TEST_TARGET, claimCreateTestOnce, readCreateTestPreflight,
  readCreateTestObservation, recordCreateTestUiAttemptUnverified,
  recordCreateTestDraftAutosaveUiUnverified } from "./createTestAttempt.mjs";
import { exportSavedCreateTestClaim,
  exportSavedCreateTestUiResult } from "./exportCreateTestRecord.mjs";
import { preparePrivateCreateOnce } from "./privateCreatePreparation.mjs";
import { openFutureCreateTrafficObservationSession } from "./session.mjs";
import { recordFutureCreateObservationOnce } from "./futureCreateObservationAttempt.mjs";
import { runPinnedPrivateCreateUiOnce } from "./privateCreateUiOnce.mjs";

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
  if (command === "prepare-private-create-no-send") {
    if (typeof flags.root !== "string" || !isAbsolute(flags.root) ||
        typeof flags.input !== "string" || !isAbsolute(flags.input))
      throw Error("Absolute queue root and small BELLO preparation file required");
    let input;
    try {
      if ((await stat(flags.input)).size > 65536)
        throw Error("File too large");
      input = JSON.parse(await readFile(flags.input, "utf8"));
    } catch {
      throw Error("BELLO_PREPARATION_FILE_INVALID");
    }
    const job = await preparePrivateCreateOnce(flags.root, input);
    process.stdout.write(JSON.stringify({ requestId: job.requestId,
      status: job.status, listingConfirmed: false }) + "\n");
    return;
  }
  if (command === "observe-future-private-create-traffic") {
    try {
      if (![flags.root, flags.profile, flags.playwright].every(value =>
        typeof value === "string" && isAbsolute(value)) ||
          typeof flags.inventory !== "string")
        throw Error("Invalid fixed observer arguments");
      const session = await openFutureCreateTrafficObservationSession({
        root: flags.root, profileDir: flags.profile,
        playwrightModulePath: flags.playwright, inventoryId: flags.inventory });
      if (session.state === "LIST_OPEN") {
        process.stdout.write("専用Shops画面での操作を観測中です。終了時はブラウザを閉じてください。\n");
        await session.closed;
      } else await session.context.close();
      const observation = await session.observer.stop();
      await recordFutureCreateObservationOnce(flags.root, flags.inventory,
        session.claim.attemptId, observation);
      process.stdout.write("通信概要を結果未確認として一回だけ記録しました。出品完了ではありません。\n");
    } catch { throw Error("FUTURE_CREATE_OBSERVATION_UNAVAILABLE"); }
    return;
  }
  if (command === "run-b005659-private-create-ui-once") {
    try {
      if (flags["confirm-code"] !== "TEST_B005659_E51E4F6B7B86DD150546" ||
          ![flags.root, flags.profile, flags.playwright, flags.image].every(value =>
            typeof value === "string" && isAbsolute(value)))
        throw Error("Invalid fixed inputs");
      const result = await runPinnedPrivateCreateUiOnce({ root: flags.root,
        profileDir: flags.profile, playwrightModulePath: flags.playwright,
        imagePath: flags.image });
      process.stdout.write(JSON.stringify({ status: result.status,
        remoteId: result.remoteId, listingConfirmed: result.listingConfirmed }) + "\n");
      if (result.retainedSession) await result.retainedSession.closed;
    } catch { throw Error("B005659_PRIVATE_CREATE_UNAVAILABLE"); }
    return;
  }
  if (command === "export-saved-direct-read-proof") {
    await exportSavedDirectReadProof({ configPath: flags.config, outputPath: flags.out });
    process.stdout.write("BELLOへ読み込む読取記録ファイルを書き出しました。Shopsへの通信は行っていません。\n");
    return;
  }
  if (command === "preflight-private-create") {
    if (typeof flags.root !== "string" || !isAbsolute(flags.root))
      throw Error("An absolute queue root is required");
    const preflight = await readCreateTestPreflight(flags.root);
    const observation = await readCreateTestObservation(flags.root);
    process.stdout.write(JSON.stringify({ preflight, claim: observation.claim,
      result: observation.result }) + "\n");
    return;
  }
  if (command === "claim-private-create-once") {
    if (typeof flags.root !== "string" || !isAbsolute(flags.root))
      throw Error("An absolute queue root is required");
    if (flags["confirm-sku"] !== CREATE_TEST_TARGET.skuCode)
      throw Error("Confirm the exact private test SKU before claiming");
    const claim = await claimCreateTestOnce(flags.root);
    process.stdout.write(JSON.stringify({ ...claim, operation: "CREATE_PRIVATE_TEST_ONCE",
      inventoryCode: CREATE_TEST_TARGET.inventoryCode,
      skuCode: CREATE_TEST_TARGET.skuCode, listingConfirmed: false }) + "\n");
    return;
  }
  if (command === "record-private-create-ui-unverified") {
    if (typeof flags.root !== "string" || !isAbsolute(flags.root))
      throw Error("An absolute queue root is required");
    if (flags["confirm-click"] !== "yes")
      throw Error("An explicit normal-UI save attempt confirmation is required");
    const result = await recordCreateTestUiAttemptUnverified(flags.root, flags.attempt);
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  if (command === "record-private-create-draft-autosave-unverified") {
    if (typeof flags.root !== "string" || !isAbsolute(flags.root))
      throw Error("An absolute queue root is required");
    if (flags["confirm-autosave"] !== "yes")
      throw Error("An explicit draft-autosave UI observation is required");
    const result = await recordCreateTestDraftAutosaveUiUnverified(flags.root, flags.attempt);
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  if (command === "export-private-create-claim" ||
      command === "export-private-create-ui-result") {
    if (command === "export-private-create-claim")
      await exportSavedCreateTestClaim(flags.root, flags.out);
    else await exportSavedCreateTestUiResult(flags.root, flags.out);
    process.stdout.write("BELLO用の固定コード記録を書き出しました。Shopsへの通信は行っていません。\n");
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
  throw Error("Commands: prepare-private-create-no-send, observe-future-private-create-traffic, run-b005659-private-create-ui-once, preflight-private-create, claim-private-create-once, record-private-create-ui-unverified, record-private-create-draft-autosave-unverified, export-private-create-claim, export-private-create-ui-result, export-saved-direct-read-proof, open-bello-login, run-cloud-read, open-login, open-existing, enqueue-read, run-read, results");
}

main().catch(error => {
  process.stderr.write(`BELLO Mercari bridge: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
