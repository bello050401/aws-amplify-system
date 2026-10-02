import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { getNextEngineAppConfiguration, type NextEngineAppConfiguration } from "./appConfiguration";
import { readNextEngineTokens, saveNextEngineTokens, type NextEngineTokenPair } from "./tokenStore";
import { assertNextEngineServerRuntime } from "./serverBoundary";
import { prepareNextEngineProduct } from "./preparation";
import { enqueuePrivateTestMaster } from "./privateUploadClient";
import { checkGoodsUploadQueue } from "./uploadQueueClient";
import { confirmPrivateTestMaster } from "./masterReadbackClient";
import { resolveNextEngineTokenRotation } from "./tokenRotation";
import { isUploadablePrivateTestCode, makePrivateMasterTestSku } from "./privateTestPolicy";

export const PRIVATE_MASTER_STAGING_ORIGIN = "https://claude-inventory-management-system-5vbvc7.d4hkkg7dty2du.amplifyapp.com";
const TOKEN_SECRET_ARN = "arn:aws:secretsmanager:us-west-2:203918843421:secret:bello/next-engine-tokens-staging-jAJyao";
const ONCE_STAGE = "BELLO_NE_TEST_ONCE";
const QUEUE_STAGE = "BELLO_NE_TEST_QUEUE";
// Version IDs are fixed for this one acceptance run, including across deploys and SKUs.
const ONCE_VERSION = "ac51b1fe-4eb9-4547-89b8-b68689b5c037";
const QUEUE_VERSION = "72e2afaa-7d40-4879-88fa-4cf721361191";
const TITLE = "BELLO 接続確認用（販売しない）";
const DESCRIPTION = "BELLOとネクストエンジンの商品マスタ登録確認用です。販売・公開しません。";
const COST = 0;
const PRICE = 300;
const MAX_BODY_BYTES = 65536;
type Phase = "AWAITING_UPLOAD" | "UNKNOWN" | "QUEUED" | "WAITING" | "PROCESSING" | "FAILED" | "MASTER_APPLIED" | "MASTER_CONFIRMED";
export type PrivateMasterAcceptanceState = { phase: Phase; sku?: string; queueId?: string; publicationConfirmed: false };

type Services = {
  getConfiguration: () => Promise<NextEngineAppConfiguration | null>;
  readTokens: (binding: NextEngineAppConfiguration) => Promise<NextEngineTokenPair | null>;
  persistTokens: (tokens: NextEngineTokenPair, binding: NextEngineAppConfiguration) => Promise<void>;
  secretClient: Pick<SecretsManagerClient, "send">;
  request: typeof fetch;
  owner: () => string;
  randomSku: () => string;
  env: Record<string, string | undefined>;
};
const defaultServices = (): Services => ({
  getConfiguration: getNextEngineAppConfiguration,
  readTokens: readNextEngineTokens,
  persistTokens: saveNextEngineTokens,
  secretClient: new SecretsManagerClient({ region: "us-west-2", maxAttempts: 1 }),
  request: fetch,
  owner: randomUUID,
  randomSku: () => makePrivateMasterTestSku(new Date().toISOString().slice(0, 10).replace(/-/g, ""), randomBytes(3).toString("hex").toUpperCase()),
  env: process.env,
});

function available(env: Services["env"]): boolean {
  return env.NEXT_ENGINE_PUBLIC_ORIGIN === PRIVATE_MASTER_STAGING_ORIGIN &&
    env.NEXT_ENGINE_TOKEN_SECRET_ID === TOKEN_SECRET_ARN &&
    env.NEXT_ENGINE_PRIVATE_MASTER_TEST_ENABLED === "1" &&
    env.NEXT_ENGINE_NO_AUTO_MALL_SYNC_CONFIRMED === "1";
}

function safeMarker(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function getStage(client: Services["secretClient"], stage: string): Promise<{ value: Record<string, unknown>; versionId: string } | null> {
  try {
    const response = await client.send(new GetSecretValueCommand({ SecretId: TOKEN_SECRET_ARN, VersionStage: stage }));
    const value: unknown = JSON.parse(response.SecretString ?? "");
    if (!safeMarker(value) || !response.VersionId || !response.VersionStages?.includes(stage)) throw new Error("invalid marker");
    return { value, versionId: response.VersionId };
  } catch (error) {
    if (error instanceof Error && error.name === "ResourceNotFoundException") return null;
    throw new Error("一回限りのテスト状態を確認できません。送信しません。");
  }
}

async function assertCurrentExists(client: Services["secretClient"]): Promise<void> {
  try {
    const response = await client.send(new GetSecretValueCommand({ SecretId: TOKEN_SECRET_ARN, VersionStage: "AWSCURRENT" }));
    if (!response.VersionId || !response.VersionStages?.includes("AWSCURRENT")) throw new Error("missing current");
  } catch { throw new Error("接続情報を確認できません。送信しません。"); }
}

async function putImmutableMarker(client: Services["secretClient"], stage: string, version: string, value: Record<string, unknown>): Promise<void> {
  const serialized = JSON.stringify(value);
  try {
    const result = await client.send(new PutSecretValueCommand({
      SecretId: TOKEN_SECRET_ARN, ClientRequestToken: version, SecretString: serialized, VersionStages: [stage],
    }));
    if (result.VersionId !== version || !result.VersionStages?.includes(stage)) throw new Error("marker mismatch");
    const readBack = await client.send(new GetSecretValueCommand({ SecretId: TOKEN_SECRET_ARN, VersionId: version, VersionStage: stage }));
    if (readBack.VersionId !== version || !readBack.VersionStages?.includes(stage) || readBack.SecretString !== serialized) {
      throw new Error("marker readback mismatch");
    }
  } catch { throw new Error("一回限りのテスト状態を確認できません。送信しません。"); }
}

async function postReadOnly(
  path: string, body: URLSearchParams, binding: NextEngineAppConfiguration, tokens: NextEngineTokenPair,
  services: Services,
): Promise<{ payload: Record<string, unknown>; tokens: NextEngineTokenPair }> {
  let response: Response;
  let payload: unknown;
  try {
    response = await services.request(`https://api.next-engine.org${path}`, {
      method: "POST", body, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    if (!response.body) throw new Error("read failed");
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) throw new Error("oversize");
    payload = JSON.parse(raw);
  } catch { throw new Error("ネクストエンジンの確認に失敗しました。送信しません。"); }
  if (!safeMarker(payload)) throw new Error("ネクストエンジンの確認に失敗しました。送信しません。");
  let rotated: ReturnType<typeof resolveNextEngineTokenRotation>;
  try { rotated = resolveNextEngineTokenRotation(tokens, payload); }
  catch { throw new Error("接続情報を確認できません。送信しません。"); }
  if (rotated.rotated) {
    await persistIfBound({ accessToken: rotated.accessToken, refreshToken: rotated.refreshToken }, binding, services);
    tokens = { accessToken: rotated.accessToken, refreshToken: rotated.refreshToken };
  }
  if (!response.ok || payload.result !== "success") throw new Error("ネクストエンジンの確認に失敗しました。送信しません。");
  return { payload, tokens };
}

const countOf = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    const count = Number(value);
    return Number.isSafeInteger(count) ? count : null;
  }
  return null;
};

function sameBinding(left: NextEngineAppConfiguration | null, right: NextEngineAppConfiguration): boolean {
  return !!left && left.credentialVersionId === right.credentialVersionId &&
    left.expectedCompanyNeId === right.expectedCompanyNeId &&
    left.clientId === right.clientId && left.clientSecret === right.clientSecret;
}

function sameTokens(left: NextEngineTokenPair | null, right: NextEngineTokenPair): boolean {
  return !!left && left.accessToken === right.accessToken && left.refreshToken === right.refreshToken;
}

async function persistIfBound(next: NextEngineTokenPair, binding: NextEngineAppConfiguration, services: Services): Promise<void> {
  if (!sameBinding(await services.getConfiguration(), binding)) throw new Error("接続設定が変更されました。送信しません。");
  await services.persistTokens(next, binding);
}

/** One server invocation can consume the fixed send right once; no retry path exists. */
export async function startPrivateMasterAcceptance(supplierCode: string, overrides: Partial<Services> = {}): Promise<PrivateMasterAcceptanceState> {
  assertNextEngineServerRuntime();
  const services = { ...defaultServices(), ...overrides };
  if (!available(services.env)) throw new Error("専用テストの安全確認が完了していません。送信しません。");
  if (!/^[A-Za-z0-9_-]{1,49}$/.test(supplierCode) || supplierCode === "SYNTHETIC") {
    throw new Error("登録済みの仕入先コードを確認してください。");
  }
  const binding = await services.getConfiguration();
  if (!binding) throw new Error("ネクストエンジンの設定を確認できません。送信しません。");
  let tokens = await services.readTokens(binding);
  if (!tokens) throw new Error("ネクストエンジンの接続が必要です。送信しません。");
  await assertCurrentExists(services.secretClient);
  if (await getStage(services.secretClient, ONCE_STAGE)) throw new Error("この専用テストは既に開始されています。再送しません。");

  const supplier = await postReadOnly("/api_v1_master_supplier/search", new URLSearchParams({
    access_token: tokens.accessToken, refresh_token: tokens.refreshToken,
    fields: "supplier_id,supplier_deleted_flag", "supplier_id-eq": supplierCode, offset: "0", limit: "2",
  }), binding, tokens, services);
  tokens = supplier.tokens;
  if (countOf(supplier.payload.count) !== 1 || !Array.isArray(supplier.payload.data) || supplier.payload.data.length !== 1 ||
      !safeMarker(supplier.payload.data[0]) || supplier.payload.data[0].supplier_id !== supplierCode ||
      ![0, "0"].includes(supplier.payload.data[0].supplier_deleted_flag as string | number)) {
    throw new Error("使用できる仕入先を確認できません。送信しません。");
  }

  const sku = services.randomSku();
  if (!isUploadablePrivateTestCode(sku)) throw new Error("専用テスト商品コードが不正です。送信しません。");
  const prepared = prepareNextEngineProduct({ sku, title: TITLE, description: DESCRIPTION,
    supplierCode, cost: COST, price: PRICE });
  const existing = await postReadOnly("/api_v1_master_goods/count", new URLSearchParams({
    access_token: tokens.accessToken, refresh_token: tokens.refreshToken, "goods_id-eq": sku,
  }), binding, tokens, services);
  tokens = existing.tokens;
  if (countOf(existing.payload.count) !== 0) throw new Error("専用テスト商品コードが既に存在するか、件数を確認できません。送信しません。");
  if (!sameBinding(await services.getConfiguration(), binding) ||
      !sameTokens(await services.readTokens(binding), tokens)) {
    throw new Error("接続設定が変更されました。送信しません。");
  }

  // A fresh owner is generated inside each invocation and never accepted from UI/env/storage.
  const owner = services.owner();
  const marker = { kind: "SEND_RIGHT_CONSUMED", owner, sku, supplierCode, title: TITLE, cost: COST, price: PRICE,
    credentialVersionId: binding.credentialVersionId, companyNeId: binding.expectedCompanyNeId };
  await putImmutableMarker(services.secretClient, ONCE_STAGE, ONCE_VERSION, marker);
  // From here, any failure is permanently non-retryable. This continuation calls upload once.
  try {
    if (!sameBinding(await services.getConfiguration(), binding) ||
        !sameTokens(await services.readTokens(binding), tokens)) {
      return { phase: "UNKNOWN", sku, publicationConfirmed: false };
    }
  } catch { return { phase: "UNKNOWN", sku, publicationConfirmed: false }; }
  let queueId: string;
  try {
    const receipt = await enqueuePrivateTestMaster(tokens,
      next => persistIfBound(next, binding, services), sku, sku, prepared, services.request);
    queueId = receipt.queueId;
  } catch { return { phase: "UNKNOWN", sku, publicationConfirmed: false }; }
  try {
    await putImmutableMarker(services.secretClient, QUEUE_STAGE, QUEUE_VERSION, { kind: "QUEUE_RECEIVED", owner, sku, queueId });
  } catch { return { phase: "UNKNOWN", sku, queueId, publicationConfirmed: false }; }
  return { phase: "QUEUED", sku, queueId, publicationConfirmed: false };
}

/** Read-only progress check. The marker never authorizes a second upload. */
export async function checkPrivateMasterAcceptance(overrides: Partial<Services> = {}): Promise<PrivateMasterAcceptanceState> {
  assertNextEngineServerRuntime();
  const services = { ...defaultServices(), ...overrides };
  if (!available(services.env)) throw new Error("専用テストの安全確認が完了していません。");
  const marker = await getStage(services.secretClient, ONCE_STAGE);
  if (!marker) return { phase: "AWAITING_UPLOAD", publicationConfirmed: false };
  const sku = marker.value.sku;
  const supplierCode = marker.value.supplierCode;
  if (marker.versionId !== ONCE_VERSION || marker.value.kind !== "SEND_RIGHT_CONSUMED" ||
      typeof sku !== "string" || typeof supplierCode !== "string" ||
      typeof marker.value.owner !== "string") throw new Error("専用テスト状態を確認できません。");
  const queued = await getStage(services.secretClient, QUEUE_STAGE);
  if (!queued) return { phase: "UNKNOWN", sku, publicationConfirmed: false };
  if (queued.versionId !== QUEUE_VERSION || queued.value.kind !== "QUEUE_RECEIVED" ||
      queued.value.owner !== marker.value.owner || queued.value.sku !== sku ||
      typeof queued.value.queueId !== "string") throw new Error("専用テスト状態を確認できません。");
  const queueId = queued.value.queueId;
  const binding = await services.getConfiguration();
  if (!binding || binding.credentialVersionId !== marker.value.credentialVersionId ||
      binding.expectedCompanyNeId !== marker.value.companyNeId) {
    return { phase: "UNKNOWN", sku, queueId, publicationConfirmed: false };
  }
  const tokens = await services.readTokens(binding);
  if (!tokens) return { phase: "UNKNOWN", sku, queueId, publicationConfirmed: false };
  try {
    const queue = await checkGoodsUploadQueue(tokens, next => persistIfBound(next, binding, services), queueId, services.request);
    if (queue.state !== "MASTER_APPLIED") return { phase: queue.state, sku, queueId, publicationConfirmed: false };
  } catch { return { phase: "UNKNOWN", sku, queueId, publicationConfirmed: false }; }
  try {
    // The queue API can rotate the pair. Read the latest bound pair before the
    // next request rather than reusing the credentials from before that call.
    const currentTokens = await services.readTokens(binding);
    if (!currentTokens) return { phase: "MASTER_APPLIED", sku, queueId, publicationConfirmed: false };
    await confirmPrivateTestMaster(currentTokens, next => persistIfBound(next, binding, services),
      { sku, title: TITLE, supplierCode, cost: COST, price: PRICE }, services.request);
    return { phase: "MASTER_CONFIRMED", sku, queueId, publicationConfirmed: false };
  } catch { return { phase: "MASTER_APPLIED", sku, queueId, publicationConfirmed: false }; }
}
