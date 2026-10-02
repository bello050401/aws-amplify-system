import "server-only";

import { createHmac } from "node:crypto";
import type { NextEngineAppConfiguration } from "./appConfiguration";

/** Non-secret reference for tying a shop choice to the NE connection that listed it. */
export function nextEngineBindingReadRef(binding: NextEngineAppConfiguration): string {
  return createHmac("sha256", binding.clientSecret).update(JSON.stringify([
    binding.clientId, binding.expectedCompanyNeId, binding.credentialVersionId,
  ])).digest("hex");
}
