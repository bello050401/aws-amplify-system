import { getNextEngineAppConfiguration } from "./appConfiguration";
import { readNextEngineTokens } from "./tokenStore";

export type NextEngineConnectionState = "CONFIGURATION_REQUIRED" | "SECRET_UNAVAILABLE" | "AWAITING_LAUNCH" | "CONNECTED";

/** Return only a status; never pass credentials or tokens to a client component. */
export async function getNextEngineConnectionState(): Promise<NextEngineConnectionState> {
  try {
    if (!getNextEngineAppConfiguration()) return "CONFIGURATION_REQUIRED";
    const tokens = await readNextEngineTokens();
    return tokens ? "CONNECTED" : "AWAITING_LAUNCH";
  } catch {
    return "SECRET_UNAVAILABLE";
  }
}
