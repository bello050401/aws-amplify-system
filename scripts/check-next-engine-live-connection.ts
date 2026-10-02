import { getNextEngineConnectionState } from "../lib/listing/nextEngine/connectionState";
import { getNextEngineAppConfiguration } from "../lib/listing/nextEngine/appConfiguration";
import { readNextEngineTokens, saveNextEngineTokens } from "../lib/listing/nextEngine/tokenStore";
import { resolveNextEngineTokenRotation } from "../lib/listing/nextEngine/tokenRotation";
import { listNextEngineSuppliers } from "../lib/listing/nextEngine/masterSync";

async function main() {
  const state = await getNextEngineConnectionState();
  if (state !== "CONNECTED") {
    console.log(JSON.stringify({ state }));
    process.exitCode = 1;
    return;
  }
  const binding = await getNextEngineAppConfiguration();
  if (!binding) throw new Error("configuration unavailable");
  const tokens = await readNextEngineTokens(binding);
  if (!tokens) throw new Error("token unavailable");
  const response = await fetch("https://api.next-engine.org/api_v1_master_shop/count", {
    method: "POST", body: new URLSearchParams({
      access_token: tokens.accessToken, refresh_token: tokens.refreshToken,
      "shop_deleted_flag-eq": "0", wait_flag: "1",
    }),
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  const payload: unknown = await response.json();
  const rotated = resolveNextEngineTokenRotation(tokens, payload);
  if (rotated.rotated) await saveNextEngineTokens({
    accessToken: rotated.accessToken, refreshToken: rotated.refreshToken,
  }, binding);
  if (!response.ok || !payload || typeof payload !== "object" || !("result" in payload) ||
      payload.result !== "success" || !("count" in payload) || !/^[0-9]+$/.test(String(payload.count))) {
    throw new Error("count unavailable");
  }
  const suppliers = await listNextEngineSuppliers();
  console.log(JSON.stringify({ state, activeShopCount: Number(payload.count), activeSupplierCount: suppliers.length }));
}

main().catch(() => { console.error("NEの店舗数を確認できませんでした。"); process.exitCode = 1; });
