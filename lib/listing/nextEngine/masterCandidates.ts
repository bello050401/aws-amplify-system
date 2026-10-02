import "server-only";

import { getNextEngineAppConfiguration, type NextEngineAppConfiguration } from "./appConfiguration";
import { readNextEngineTokens, saveNextEngineTokens, type NextEngineTokenPair } from "./tokenStore";
import { resolveNextEngineTokenRotation } from "./tokenRotation";
import { assertNextEngineServerRuntime } from "./serverBoundary";
import { PRIVATE_MASTER_STAGING_ORIGIN } from "./privateMasterAcceptance";
import { nextEngineBindingReadRef } from "./bindingReadRef";

export type MasterCandidates = {
  bindingRef: string;
  suppliers: { code: string; name: string }[];
  shops: { id: string; name: string; mallId: string }[];
  suppliersMore: boolean;
  shopsMore: boolean;
};

const LIMIT = 50;
const TOKEN_SECRET_ARN = "arn:aws:secretsmanager:us-west-2:203918843421:secret:bello/next-engine-tokens-staging-jAJyao";
export type MasterCandidatesErrorCode = "STAGING_CONFIGURATION" | "CONNECTION" | "BINDING_CHANGED" |
  "SUPPLIER_TRANSPORT" | "SUPPLIER_RESPONSE" | "SUPPLIER_TOKEN" | "SUPPLIER_API" | "SUPPLIER_ROWS" |
  "SHOP_TRANSPORT" | "SHOP_RESPONSE" | "SHOP_TOKEN" | "SHOP_API" | "SHOP_ROWS";
export class MasterCandidatesError extends Error {
  constructor(readonly code: MasterCandidatesErrorCode,
    readonly apiCode?: string, readonly httpStatus?: number) {
    super("ネクストエンジンの登録情報を確認できませんでした。");
  }
}
const failure = (code: MasterCandidatesErrorCode, apiCode?: string, httpStatus?: number) =>
  new MasterCandidatesError(code, apiCode, httpStatus);
const officialApiCode = (value: unknown): string | undefined =>
  typeof value === "string" && /^[0-9]{6}$/.test(value) ? value : undefined;
const safeHttpStatus = (value: number): number | undefined =>
  Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
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
      services.env.NEXT_ENGINE_TOKEN_SECRET_ID !== TOKEN_SECRET_ARN) throw failure("STAGING_CONFIGURATION");
  let binding: NextEngineAppConfiguration | null;
  try { binding = await services.configuration(); }
  catch { throw failure("CONNECTION"); }
  if (!binding) throw failure("CONNECTION");
  const confirmedBinding: NextEngineAppConfiguration = binding;
  let tokens: NextEngineTokenPair | null;
  try { tokens = await services.readTokens(confirmedBinding); }
  catch { throw failure("CONNECTION"); }
  if (!tokens) throw failure("CONNECTION");
  async function assertBinding(): Promise<void> {
    let current: NextEngineAppConfiguration | null;
    try { current = await services.configuration(); }
    catch { throw failure("BINDING_CHANGED"); }
    if (!sameBinding(current, confirmedBinding)) throw failure("BINDING_CHANGED");
  }

  async function search(kind: "SUPPLIER" | "SHOP", path: string, fields: string): Promise<Record<string, unknown>> {
    await assertBinding();
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
      if (!response.body) throw failure(`${kind}_TRANSPORT`);
      const raw = await response.text();
      if (Buffer.byteLength(raw, "utf8") > 65536) throw failure(`${kind}_TRANSPORT`);
      payload = JSON.parse(raw);
    } catch { throw failure(`${kind}_TRANSPORT`); }
    if (!object(payload)) throw failure(`${kind}_RESPONSE`);
    let rotation: ReturnType<typeof resolveNextEngineTokenRotation>;
    try { rotation = resolveNextEngineTokenRotation(tokens!, payload); }
    catch { throw failure(`${kind}_TOKEN`); }
    if (rotation.rotated) {
      await assertBinding();
      tokens = { accessToken: rotation.accessToken, refreshToken: rotation.refreshToken };
      try { await services.saveTokens(tokens, confirmedBinding); }
      catch { throw failure(`${kind}_TOKEN`); }
    }
    if (!response.ok || payload.result !== "success") {
      throw failure(`${kind}_API`, officialApiCode(payload.code), safeHttpStatus(response.status));
    }
    if (!Array.isArray(payload.data) || payload.data.length > LIMIT || count(payload.count) === null) {
      throw failure(`${kind}_RESPONSE`);
    }
    return payload;
  }

  const supplier = await search("SUPPLIER", "/api_v1_master_supplier/search", "supplier_id,supplier_name,supplier_deleted_flag");
  const shop = await search("SHOP", "/api_v1_master_shop/search", "shop_id,shop_name,shop_mall_id,shop_deleted_flag");
  await assertBinding();
  const suppliers: MasterCandidates["suppliers"] = [];
  for (const value of supplier.data as unknown[]) {
    if (!object(value)) throw failure("SUPPLIER_ROWS");
    if (value.supplier_deleted_flag !== "0" && value.supplier_deleted_flag !== 0) continue;
    if (!safeText(value.supplier_id, 49) || !/^[A-Za-z0-9_-]+$/.test(value.supplier_id) ||
        !safeText(value.supplier_name, 200)) throw failure("SUPPLIER_ROWS");
    suppliers.push({ code: value.supplier_id, name: value.supplier_name });
  }
  const shops: MasterCandidates["shops"] = [];
  for (const value of shop.data as unknown[]) {
    if (!object(value)) throw failure("SHOP_ROWS");
    if (value.shop_deleted_flag !== "0" && value.shop_deleted_flag !== 0) continue;
    const id = String(value.shop_id);
    const mallId = String(value.shop_mall_id);
    if (!/^[0-9]{1,12}$/.test(id) || !/^[0-9]{1,12}$/.test(mallId) || !safeText(value.shop_name, 200)) throw failure("SHOP_ROWS");
    shops.push({ id, name: value.shop_name, mallId });
  }
  return {
    bindingRef: nextEngineBindingReadRef(confirmedBinding),
    suppliers, shops,
    suppliersMore: count(supplier.count)! > (supplier.data as unknown[]).length,
    shopsMore: count(shop.count)! > (shop.data as unknown[]).length,
  };
}
