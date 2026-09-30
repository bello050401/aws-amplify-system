import { getNextEngineAppConfiguration } from "./appConfiguration";
import { inspectNextEngineTokens, type NextEngineTokenStatus, type NextEngineTokenPair } from "./tokenStore";
import type { NextEngineAppConfiguration } from "./appConfiguration";

export type NextEngineConnectionState = "CONFIGURATION_REQUIRED" | "SECRET_UNAVAILABLE" | "AWAITING_LAUNCH" |
  "TOKEN_REFERENCE_INVALID" | "TOKEN_READ_UNAVAILABLE" | "TOKEN_FORMAT_INVALID" |
  "TOKEN_VERSION_MISMATCH" | "TOKEN_COMPANY_MISMATCH" | "APP_CONFIGURATION_CHANGED" | "CONNECTED";

/** Return only a status; never pass credentials or tokens to a client component. */
export async function getNextEngineConnectionState(deps: {
  configuration: () => Promise<NextEngineAppConfiguration | null>;
  readTokens?: (config: NextEngineAppConfiguration) => Promise<NextEngineTokenPair | null>;
  inspectTokens?: (config: NextEngineAppConfiguration) => Promise<NextEngineTokenStatus>;
} = { configuration: getNextEngineAppConfiguration, inspectTokens: inspectNextEngineTokens }): Promise<NextEngineConnectionState> {
  try {
    const config = await deps.configuration();
    if (!config) return "CONFIGURATION_REQUIRED";
    let tokenStatus: NextEngineTokenStatus;
    if (deps.inspectTokens) tokenStatus = await deps.inspectTokens(config);
    else if (deps.readTokens) tokenStatus = await deps.readTokens(config) ? "READY" : "EMPTY";
    else return "SECRET_UNAVAILABLE";
    const tokenStates: Partial<Record<NextEngineTokenStatus, NextEngineConnectionState>> = {
      EMPTY: "AWAITING_LAUNCH",
      REFERENCE_INVALID: "TOKEN_REFERENCE_INVALID",
      READ_ERROR: "TOKEN_READ_UNAVAILABLE",
      INVALID_FORMAT: "TOKEN_FORMAT_INVALID",
      CREDENTIAL_VERSION_MISMATCH: "TOKEN_VERSION_MISMATCH",
      COMPANY_MISMATCH: "TOKEN_COMPANY_MISMATCH",
    };
    if (tokenStatus !== "READY") return tokenStates[tokenStatus] ?? "SECRET_UNAVAILABLE";
    const current = await deps.configuration();
    return current?.credentialVersionId === config.credentialVersionId &&
      current.expectedCompanyNeId === config.expectedCompanyNeId ? "CONNECTED" : "APP_CONFIGURATION_CHANGED";
  } catch {
    return "SECRET_UNAVAILABLE";
  }
}
