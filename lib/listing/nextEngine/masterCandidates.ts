import "server-only";

import { getNextEngineAppConfiguration, type NextEngineAppConfiguration } from "./appConfiguration";
import { readNextEngineTokens, saveNextEngineTokens, type NextEngineTokenPair } from "./tokenStore";
import { resolveNextEngineTokenRotation } from "./tokenRotation";
import { assertNextEngineServerRuntime } from "./serverBoundary";
import { PRIVATE_MASTER_STAGING_ORIGIN } from "./privateMasterAcceptance";

export type MasterCandidates = {
  suppliers: { code: string; name: string }[];
  shops: { id: string; name: string; mallId: string }[];
  suppliersMore: boolean;
  shopsMore: boolean;
};

const LIMIT = 50;
const TOKEN_SECRET_ARN = "arn:aws:secretsmanager:us-west-2:203918843421:secret:bello/next-engine-tokens-staging-jAJyao";
const failure = () => new Error("ネクストエンジンの登録情報を確認できませんでした。");
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const safeText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const count = (value: unknown): number | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};
const sameBinding = (a: NextEngineAppConfiguration | null, b: NextEngineAppConfiguration) =>
  !!a && a.clientId === b.clientId && a.clientSecret === b.clientSecret &&
  a.expectedCompanyNeId === b.expectedCompanyNeId && a.credentialVersionId === b.credentialVersionId;

type Services = {
  configuration: () => Promise<NextEngineAppConfiguration | null>;
  readTokens: (binding: NextEngineAppConfiguration) => Promise<NextEngineTokenPair | null>;
  saveTokens: (tokens: NextEngineTokenPair, binding: NextEngineAppConfiguration) => Promise<void>;
  request: typeof fetch;
  env: Record<string, string | undefined>;
};

/** Read-only Next Engine master search. Only whitelisted master fields leave this module. */
export async function listNextEngineMasterCandidates(overrides: Partial<Services> = {}): Promise<MasterCandidates> {
  assertNextEngineServerRuntime();
  const services: Services = {
    configuration: getNextEngineAppConfiguration, readTokens: readNextEngineTokens,
    saveTokens: saveNextEngineTokens, request: fetch, env: process.env, ...overrides,
  };
  if (services.env.NEXT_ENGINE_PUBLIC_ORIGIN !== PRIVATE_MASTER_STAGING_ORIGIN ||
      services.env.NEXT_ENGINE_TOKEN_SECRET_ID !== TOKEN_SECRET_ARN) throw failure();
  const binding = await services.configuration();
  if (!binding) throw failure();
  const confirmedBinding: NextEngineAppConfiguration = binding;
  let tokens = await services.readTokens(confirmedBinding);
  if (!tokens) throw failure();

  async function search(path: string, fields: string): Promise<Record<string, unknown>> {
    if (!sameBinding(await services.configuration(), confirmedBinding)) throw failure();
    const body = new URLSearchParams({
      access_token: tokens!.accessToken, refresh_token: tokens!.refreshToken,
      wait_flag: "1", fields, offset: "0", limit: String(LIMIT),
    });
    let response: Response;
    let payload: unknown;
    try {
      response = await services.request(`https://api.next-engine.org${path}`, {
        method: "POST", body, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20_000),
      });
      if (!response.body) throw failure();
      const raw = await response.text();
      if (Buffer.byteLength(raw, "utf8") > 65536) throw failure();
      payload = JSON.parse(raw);
    } catch { throw failure(); }
    if (!object(payload)) throw failure();
    let rotation: ReturnType<typeof resolveNextEngineTokenRotation>;
    try { rotation = resolveNextEngineTokenRotation(tokens!, payload); }
    catch { throw failure(); }
    if (rotation.rotated) {
      if (!sameBinding(await services.configuration(), confirmedBinding)) throw failure();
      tokens = { accessToken: rotation.accessToken, refreshToken: rotation.refreshToken };
      await services.saveTokens(tokens, confirmedBinding);
    }
    if (!response.ok || payload.result !== "success" || !Array.isArray(payload.data) ||
        payload.data.length > LIMIT || count(payload.count) === null) throw failure();
    return payload;
  }

  const supplier = await search("/api_v1_master_supplier/search", "supplier_id,supplier_name,supplier_deleted_flag");
  const shop = await search("/api_v1_master_shop/search", "shop_id,shop_name,shop_mall_id,shop_deleted_flag");
  if (!sameBinding(await services.configuration(), confirmedBinding)) throw failure();
  const suppliers: MasterCandidates["suppliers"] = [];
  for (const value of supplier.data as unknown[]) {
    if (!object(value)) throw failure();
    if (value.supplier_deleted_flag !== "0" && value.supplier_deleted_flag !== 0) continue;
    if (!safeText(value.supplier_id, 49) || !/^[A-Za-z0-9_-]+$/.test(value.supplier_id) ||
        !safeText(value.supplier_name, 200)) throw failure();
    suppliers.push({ code: value.supplier_id, name: value.supplier_name });
  }
  const shops: MasterCandidates["shops"] = [];
  for (const value of shop.data as unknown[]) {
    if (!object(value)) throw failure();
    if (value.shop_deleted_flag !== "0" && value.shop_deleted_flag !== 0) continue;
    const id = String(value.shop_id);
    const mallId = String(value.shop_mall_id);
    if (!/^[0-9]{1,12}$/.test(id) || !/^[0-9]{1,12}$/.test(mallId) || !safeText(value.shop_name, 200)) throw failure();
    shops.push({ id, name: value.shop_name, mallId });
  }
  return {
    suppliers, shops,
    suppliersMore: count(supplier.count)! > (supplier.data as unknown[]).length,
    shopsMore: count(shop.count)! > (shop.data as unknown[]).length,
  };
}
