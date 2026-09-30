import { getNextEngineAppConfiguration } from "./appConfiguration";
import { readNextEngineTokens } from "./tokenStore";
import type { NextEngineAppConfiguration } from "./appConfiguration";
import type { NextEngineTokenPair } from "./tokenStore";

export type NextEngineConnectionState = "CONFIGURATION_REQUIRED" | "SECRET_UNAVAILABLE" | "AWAITING_LAUNCH" | "CONNECTED";

/** Return only a status; never pass credentials or tokens to a client component. */
export async function getNextEngineConnectionState(deps: {
  configuration: () => Promise<NextEngineAppConfiguration | null>;
  readTokens: (config: NextEngineAppConfiguration) => Promise<NextEngineTokenPair | null>;
} = { configuration: getNextEngineAppConfiguration, readTokens: readNextEngineTokens }): Promise<NextEngineConnectionState> {
  try {
    const config = await deps.configuration();
    if (!config) return "CONFIGURATION_REQUIRED";
    const tokens = await deps.readTokens(config);
    if (!tokens) return "AWAITING_LAUNCH";
    const current = await deps.configuration();
    return current?.credentialVersionId === config.credentialVersionId &&
      current.expectedCompanyNeId === config.expectedCompanyNeId ? "CONNECTED" : "AWAITING_LAUNCH";
  } catch {
    return "SECRET_UNAVAILABLE";
  }
}
