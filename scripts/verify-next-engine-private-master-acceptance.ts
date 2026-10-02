import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GetSecretValueCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { checkPrivateMasterAcceptance, startPrivateMasterAcceptance,
  checkSecondPrivateMasterAcceptance, startSecondPrivateMasterAcceptance } from "../lib/listing/nextEngine/privateMasterAcceptance";
import { isReservedNextEngineTestCode, isUploadablePrivateTestCode, makePrivateMasterTestSku } from "../lib/listing/nextEngine/privateTestPolicy";

const origin = "https://claude-inventory-management-system-5vbvc7.d4hkkg7dty2du.amplifyapp.com";
const secretId = "arn:aws:secretsmanager:us-west-2:203918843421:secret:bello/next-engine-tokens-staging-jAJyao";
const env = {
  NEXT_ENGINE_PUBLIC_ORIGIN: origin, NEXT_ENGINE_TOKEN_SECRET_ID: secretId,
  NEXT_ENGINE_PRIVATE_MASTER_TEST_ENABLED: "1", NEXT_ENGINE_NO_AUTO_MALL_SYNC_CONFIRMED: "1",
};
const binding = { clientId: "fixture", clientSecret: "fixture", expectedCompanyNeId: "fixture", credentialVersionId: "fixture-version" };
const initialTokens = { accessToken: "fixture-access", refreshToken: "fixture-refresh" };
const response = (payload: object, status = 200) => new Response(JSON.stringify(payload), { status });

function fixture(options: { uncertainPut?: boolean; uncertainQueuePut?: boolean; delayedReadback?: boolean; uploadTimeout?: boolean;
  existingSku?: boolean; supplierMissing?: boolean; changeBindingAt?: "afterSupplier" | "afterMarker";
  supplierResponseMode?: "errorRotated" | "invalidTokens"; priorQueueStatus?: "-1" | "1" | "2";
  priorMasterExists?: boolean } = {}) {
  const versions = new Map<string, { id: string; value: string }>();
  let uploads = 0;
  let owner = 0;
  let tokens = initialTokens;
  let activeBinding = binding;
  const calls: string[] = [];
  const secretClient = {
    async send(command: GetSecretValueCommand | PutSecretValueCommand): Promise<any> {
      if (command instanceof GetSecretValueCommand) {
        const stage = command.input.VersionStage ?? "AWSCURRENT";
        if (stage === "AWSCURRENT") return { VersionId: "current-version", VersionStages: [stage], SecretString: "{}" };
        const value = versions.get(stage);
        if (!value) throw Object.assign(new Error("missing"), { name: "ResourceNotFoundException" });
        if (options.delayedReadback && command.input.VersionId) throw new Error("readback delay");
        if (options.changeBindingAt === "afterMarker" && stage === "BELLO_NE_TEST_ONCE" && command.input.VersionId) {
          activeBinding = { ...binding, credentialVersionId: "new-company-version" };
        }
        return { VersionId: value.id, VersionStages: [stage], SecretString: value.value };
      }
      if (command instanceof PutSecretValueCommand) {
        const [stage] = command.input.VersionStages ?? [];
        assert.ok(stage && stage !== "AWSCURRENT");
        assert.equal(command.input.SecretId, secretId);
        const id = command.input.ClientRequestToken!;
        const value = command.input.SecretString!;
        const existing = versions.get(stage);
        if (existing) {
          if (existing.id === id && existing.value === value) return { VersionId: id, VersionStages: [stage] };
          throw Object.assign(new Error("version conflict"), { name: "InvalidRequestException" });
        }
        versions.set(stage, { id, value });
        if (options.uncertainPut && stage === "BELLO_NE_TEST_ONCE") throw new Error("response lost");
        if (options.uncertainQueuePut && stage === "BELLO_NE_TEST_QUEUE") throw new Error("response lost");
        return { VersionId: id, VersionStages: [stage] };
      }
      throw new Error("unexpected command");
    },
  };
  const request: typeof fetch = async (url, init) => {
    const path = String(url).replace("https://api.next-engine.org", "");
    const body = init?.body as URLSearchParams;
    calls.push(path);
    assert.equal(body.get("access_token"), tokens.accessToken);
    if (path === "/api_v1_master_supplier/search") {
      if (options.changeBindingAt === "afterSupplier") activeBinding = { ...binding, credentialVersionId: "new-company-version" };
      if (options.supplierResponseMode === "errorRotated") return response({ result: "error",
        access_token: "rotated-access", refresh_token: "rotated-refresh" }, 400);
      if (options.supplierResponseMode === "invalidTokens") return response({ result: "success", count: "1",
        data: [{ supplier_id: "REAL_SUPPLIER", supplier_deleted_flag: "0" }], access_token: null, refresh_token: 123 });
      return response({ result: "success", count: options.supplierMissing ? "0" : "1",
        data: options.supplierMissing ? [] : [{ supplier_id: "REAL_SUPPLIER", supplier_deleted_flag: "0" }] });
    }
    if (path === "/api_v1_master_goods/count") return response({ result: "success",
      count: body.get("goods_id-eq") === "BELLO-NE-TEST-20261002-DEE8ECFB92D2"
        ? (options.priorMasterExists ? "1" : "0") : (options.existingSku ? "1" : "0") });
    if (path === "/api_v1_master_goods/upload") {
      uploads++;
      assert.match(body.get("data") ?? "", /^syohin_code,sire_code,/);
      if (options.uploadTimeout) throw new Error("timeout");
      return response({ result: "success", que_id: "12345" });
    }
    if (path === "/api_v1_system_que/search") {
      // Simulate token rotation before the goods-master readback.
      const prior = body.get("que_id-eq") === "1";
      return response({ result: "success", data: [{ que_id: prior ? "1" : "12345", que_method_name: "SYOHIN_KIHON_CSV", que_status_id: prior ? (options.priorQueueStatus ?? "-1") : "2",
        access_token: "rotated-access", refresh_token: "rotated-refresh" }],
        access_token: "rotated-access", refresh_token: "rotated-refresh" });
    }
    if (path === "/api_v1_master_goods/search") return response({ result: "success", data: [{
      goods_id: "BELLO-NE-TEST-20260930-ABCDEF", goods_name: "BELLO 接続確認用（販売しない）",
      goods_supplier_id: "REAL_SUPPLIER", goods_cost_price: "0", goods_selling_price: "300",
    }] });
    throw new Error(`unexpected path ${path}`);
  };
  const overrides = {
    env,
    getConfiguration: async () => activeBinding,
    readTokens: async () => tokens,
    persistTokens: async (next: typeof tokens) => { tokens = next; },
    secretClient: secretClient as any,
    request,
    owner: () => `owner-${++owner}`,
    randomSku: () => "BELLO-NE-TEST-20260930-ABCDEF",
  };
  return { overrides, versions, calls, get uploads() { return uploads; }, get tokens() { return tokens; } };
}

function seedFailedFirstAttempt(test: ReturnType<typeof fixture>) {
  const owner = "first-owner";
  const sku = "BELLO-NE-TEST-20261002-DEE8ECFB92D2";
  test.versions.set("BELLO_NE_TEST_ONCE", { id: "ac51b1fe-4eb9-4547-89b8-b68689b5c037",
    value: JSON.stringify({ kind: "SEND_RIGHT_CONSUMED", owner, sku, supplierCode: "REAL_SUPPLIER",
      credentialVersionId: binding.credentialVersionId, companyNeId: binding.expectedCompanyNeId }) });
  test.versions.set("BELLO_NE_TEST_QUEUE", { id: "72e2afaa-7d40-4879-88fa-4cf721361191",
    value: JSON.stringify({ kind: "QUEUE_RECEIVED", owner, sku, queueId: "1" }) });
}

async function main() {
  const amplifyBuild = readFileSync(new URL("../amplify.yml", import.meta.url), "utf8");
  assert.ok(amplifyBuild.includes('NEXT_ENGINE_PRIVATE_MASTER_TEST_V2_ENABLED=${NEXT_ENGINE_PRIVATE_MASTER_TEST_V2_ENABLED:-0}'));
  const prefix = "BELLO-NE-TEST-20260930-";
  assert.equal(prefix.length, 23);
  assert.equal(makePrivateMasterTestSku("20260930", "ABCDEF"), `${prefix}ABCDEF`);
  assert.equal(makePrivateMasterTestSku("20260930", "ABCDEF").length, 29);
  assert.throws(() => makePrivateMasterTestSku("20260930", "ABCDEFG"));
  assert.throws(() => makePrivateMasterTestSku("20260930", "ABCDE"));
  assert.equal(isUploadablePrivateTestCode(`${prefix}ABCDEFG`), true);
  assert.equal(isUploadablePrivateTestCode(`${prefix}ABCDEFGH`), false);
  assert.equal(isUploadablePrivateTestCode(`${prefix}AB_CDE`), false);
  assert.equal(isReservedNextEngineTestCode("BELLO-NE-TEST-20261002-DEE8ECFB92D2"), true);
  assert.equal(isUploadablePrivateTestCode("BELLO-NE-TEST-20261002-DEE8ECFB92D2"), false);

  const good = fixture();
  const first = await startPrivateMasterAcceptance("REAL_SUPPLIER", good.overrides);
  assert.equal(first.phase, "QUEUED");
  assert.equal(good.uploads, 1);
  assert.equal(good.versions.size, 2);
  await assert.rejects(startPrivateMasterAcceptance("REAL_SUPPLIER", good.overrides), /既に開始/);
  assert.equal(good.uploads, 1);
  const checked = await checkPrivateMasterAcceptance(good.overrides);
  assert.equal(checked.phase, "MASTER_CONFIRMED");
  assert.equal(checked.publicationConfirmed, false);
  assert.deepEqual(good.calls.slice(-2), ["/api_v1_system_que/search", "/api_v1_master_goods/search"]);

  const overlong = fixture();
  await assert.rejects(startPrivateMasterAcceptance("REAL_SUPPLIER", {
    ...overlong.overrides, randomSku: () => "BELLO-NE-TEST-20261002-DEE8ECFB92D2",
  }), /商品コードが不正/);
  assert.equal(overlong.uploads, 0);
  assert.equal(overlong.versions.size, 0);

  const secondDisabled = fixture();
  seedFailedFirstAttempt(secondDisabled);
  await assert.rejects(startSecondPrivateMasterAcceptance("REAL_SUPPLIER", secondDisabled.overrides));
  assert.equal(secondDisabled.calls.length, 0);
  assert.equal(secondDisabled.uploads, 0);
  const secondEnv = { ...env, NEXT_ENGINE_PRIVATE_MASTER_TEST_ENABLED: "0", NEXT_ENGINE_PRIVATE_MASTER_TEST_V2_ENABLED: "1" };
  await assert.rejects(startSecondPrivateMasterAcceptance("REAL_SUPPLIER", {
    ...secondDisabled.overrides, env: { ...env, NEXT_ENGINE_PRIVATE_MASTER_TEST_V2_ENABLED: "1" },
  }));
  assert.equal(secondDisabled.calls.length, 0);
  const second = fixture();
  seedFailedFirstAttempt(second);
  const secondOverrides = { ...second.overrides, env: secondEnv };
  assert.equal((await checkSecondPrivateMasterAcceptance(secondOverrides)).phase, "AWAITING_UPLOAD");
  assert.equal((await startSecondPrivateMasterAcceptance("REAL_SUPPLIER", secondOverrides)).phase, "QUEUED");
  assert.equal(second.uploads, 1);
  assert.equal(second.versions.size, 4);
  assert.equal(second.versions.get("BELLO_NE_TEST_ONCE")?.id, "ac51b1fe-4eb9-4547-89b8-b68689b5c037");
  assert.equal((await checkSecondPrivateMasterAcceptance(secondOverrides)).phase, "MASTER_CONFIRMED");
  await assert.rejects(startSecondPrivateMasterAcceptance("REAL_SUPPLIER", secondOverrides), /既に開始/);
  assert.equal(second.uploads, 1);
  const secondConcurrent = fixture();
  seedFailedFirstAttempt(secondConcurrent);
  const concurrentOverrides = { ...secondConcurrent.overrides, env: secondEnv };
  const secondResults = await Promise.allSettled([
    startSecondPrivateMasterAcceptance("REAL_SUPPLIER", concurrentOverrides),
    startSecondPrivateMasterAcceptance("REAL_SUPPLIER", concurrentOverrides),
  ]);
  assert.equal(secondResults.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(secondConcurrent.uploads, 1);
  const orphanQueue = fixture();
  seedFailedFirstAttempt(orphanQueue);
  orphanQueue.versions.set("BELLO_NE_TEST_QUEUE_V2", { id: "6eb9939b-8a7e-47ac-8926-309438129a12",
    value: JSON.stringify({ kind: "QUEUE_RECEIVED", owner: "other-owner", sku: "BELLO-NE-TEST-20261002-ABCDEF", queueId: "2" }) });
  await assert.rejects(startSecondPrivateMasterAcceptance("REAL_SUPPLIER", { ...orphanQueue.overrides, env: secondEnv }), /既に開始/);
  assert.equal(orphanQueue.uploads, 0);
  for (const options of [{}, { priorQueueStatus: "1" as const }, { priorQueueStatus: "2" as const },
    { priorMasterExists: true }, { existingSku: true }]) {
    const blocked = fixture(options);
    if (Object.keys(options).length > 0) seedFailedFirstAttempt(blocked);
    await assert.rejects(startSecondPrivateMasterAcceptance("REAL_SUPPLIER", { ...blocked.overrides, env: secondEnv }));
    assert.equal(blocked.uploads, 0);
    assert.equal(blocked.versions.size, Object.keys(options).length > 0 ? 2 : 0);
  }
  const wrongSupplier = fixture();
  seedFailedFirstAttempt(wrongSupplier);
  await assert.rejects(startSecondPrivateMasterAcceptance("OTHER_SUPPLIER", { ...wrongSupplier.overrides, env: secondEnv }));
  assert.equal(wrongSupplier.uploads, 0);
  const wrongBinding = fixture();
  seedFailedFirstAttempt(wrongBinding);
  const old = wrongBinding.versions.get("BELLO_NE_TEST_ONCE")!;
  wrongBinding.versions.set("BELLO_NE_TEST_ONCE", { ...old,
    value: JSON.stringify({ ...JSON.parse(old.value), companyNeId: "other-company" }) });
  await assert.rejects(startSecondPrivateMasterAcceptance("REAL_SUPPLIER", { ...wrongBinding.overrides, env: secondEnv }));
  assert.equal(wrongBinding.uploads, 0);
  const secondUnknown = fixture({ uploadTimeout: true });
  seedFailedFirstAttempt(secondUnknown);
  const unknownOverrides = { ...secondUnknown.overrides, env: secondEnv };
  assert.equal((await startSecondPrivateMasterAcceptance("REAL_SUPPLIER", unknownOverrides)).phase, "UNKNOWN");
  await assert.rejects(startSecondPrivateMasterAcceptance("REAL_SUPPLIER", unknownOverrides));
  assert.equal(secondUnknown.uploads, 1);

  const concurrent = fixture();
  const results = await Promise.allSettled([
    startPrivateMasterAcceptance("REAL_SUPPLIER", concurrent.overrides),
    startPrivateMasterAcceptance("REAL_SUPPLIER", concurrent.overrides),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(concurrent.uploads, 1);

  for (const options of [{ uncertainPut: true }, { delayedReadback: true }]) {
    const test = fixture(options);
    await assert.rejects(startPrivateMasterAcceptance("REAL_SUPPLIER", test.overrides));
    assert.equal(test.uploads, 0);
    await assert.rejects(startPrivateMasterAcceptance("REAL_SUPPLIER", test.overrides));
    assert.equal(test.uploads, 0);
  }
  const timeout = fixture({ uploadTimeout: true });
  assert.equal((await startPrivateMasterAcceptance("REAL_SUPPLIER", timeout.overrides)).phase, "UNKNOWN");
  assert.equal((await checkPrivateMasterAcceptance(timeout.overrides)).phase, "UNKNOWN");
  await assert.rejects(startPrivateMasterAcceptance("REAL_SUPPLIER", timeout.overrides));
  assert.equal(timeout.uploads, 1);

  const uncertainQueue = fixture({ uncertainQueuePut: true });
  assert.equal((await startPrivateMasterAcceptance("REAL_SUPPLIER", uncertainQueue.overrides)).phase, "UNKNOWN");
  await assert.rejects(startPrivateMasterAcceptance("REAL_SUPPLIER", uncertainQueue.overrides));
  assert.equal(uncertainQueue.uploads, 1);

  for (const options of [{ existingSku: true }, { supplierMissing: true }]) {
    const test = fixture(options);
    await assert.rejects(startPrivateMasterAcceptance("REAL_SUPPLIER", test.overrides));
    assert.equal(test.uploads, 0);
    assert.equal(test.versions.size, 0);
  }
  const disabled = fixture();
  await assert.rejects(startPrivateMasterAcceptance("REAL_SUPPLIER", {
    ...disabled.overrides, env: { ...env, NEXT_ENGINE_NO_AUTO_MALL_SYNC_CONFIRMED: "0" },
  }));
  assert.equal(disabled.calls.length, 0);
  assert.equal(disabled.versions.size, 0);
  const disconnected = fixture();
  await assert.rejects(startPrivateMasterAcceptance("REAL_SUPPLIER", {
    ...disconnected.overrides, readTokens: async () => null,
  }));
  assert.equal(disconnected.calls.length, 0);
  assert.equal(disconnected.versions.size, 0);
  for (const changeBindingAt of ["afterSupplier", "afterMarker"] as const) {
    const changed = fixture({ changeBindingAt });
    if (changeBindingAt === "afterSupplier") {
      await assert.rejects(startPrivateMasterAcceptance("REAL_SUPPLIER", changed.overrides), /接続設定が変更/);
      assert.equal(changed.versions.size, 0);
    } else {
      assert.equal((await startPrivateMasterAcceptance("REAL_SUPPLIER", changed.overrides)).phase, "UNKNOWN");
      assert.equal(changed.versions.size, 1);
    }
    assert.equal(changed.uploads, 0);
  }
  const errorRotated = fixture({ supplierResponseMode: "errorRotated" });
  await assert.rejects(startPrivateMasterAcceptance("REAL_SUPPLIER", errorRotated.overrides));
  assert.equal(errorRotated.tokens.accessToken, "rotated-access");
  assert.equal(errorRotated.uploads, 0);
  const invalidTokens = fixture({ supplierResponseMode: "invalidTokens" });
  await assert.rejects(startPrivateMasterAcceptance("REAL_SUPPLIER", invalidTokens.overrides));
  assert.equal(invalidTokens.tokens.accessToken, initialTokens.accessToken);
  assert.equal(invalidTokens.uploads, 0);
  console.log("Private master acceptance: all synthetic checks passed");
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
