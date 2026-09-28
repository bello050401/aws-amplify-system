import { NextResponse } from "next/server";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { resolveAppOrigin } from "@/lib/base/redirectUri";
import { getNextEngineAppConfiguration } from "@/lib/listing/nextEngine/appConfiguration";
import { exchangeNextEngineLaunch } from "@/lib/listing/nextEngine/authExchange";
import { completeNextEngineLaunch } from "@/lib/listing/nextEngine/completeLaunch";
import { readNextEngineTokens, saveNextEngineTokens } from "@/lib/listing/nextEngine/tokenStore";

/** Next Engine's registered Redirect URI. Only the server sees exchanged tokens. */
export async function GET(request: Request) {
  const origin = resolveAppOrigin(request);
  const destination = new URL("/inventory/settings", origin);
  if ((await getInventoryRole()) !== "ADMIN") {
    return NextResponse.redirect(new URL("/inventory/login", origin));
  }
  const url = new URL(request.url);
  const uid = url.searchParams.get("uid");
  const state = url.searchParams.get("state");
  if (!uid || !state) {
    destination.searchParams.set("nextEngineError", "認証設定または起動情報が不足しています。");
    return NextResponse.redirect(destination);
  }
  try {
    const config = getNextEngineAppConfiguration();
    if (!config) throw new Error("App configuration missing");
    await completeNextEngineLaunch({ ...config, uid, state }, {
      // Fail before consuming the one-use launch state if the dedicated secret is unavailable.
      preflight: readNextEngineTokens,
      exchange: exchangeNextEngineLaunch,
      save: saveNextEngineTokens,
      readBack: readNextEngineTokens,
    });
    destination.searchParams.set("nextEngineConnected", "1");
  } catch {
    // Never return credentials, launch state, official response bodies, or storage errors.
    destination.searchParams.set("nextEngineError", "ネクストエンジンの接続を確認できませんでした。設定を確認してください。");
  }
  return NextResponse.redirect(destination);
}
