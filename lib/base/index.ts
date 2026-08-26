import type { BaseApiClient } from "./client";
import { MockBaseApiClient } from "./client.mock";
import { RealBaseApiClient } from "./client.real";

export type { BaseApiClient } from "./client";
export { BaseApiError } from "./client";
export * from "./types";

let instance: BaseApiClient | null = null;

/**
 * Single entry point every route/component should import instead of
 * reaching for MockBaseApiClient / RealBaseApiClient directly. Flip
 * `BASE_USE_MOCK=false` once the real client has been verified — no
 * caller code needs to change.
 */
export function getBaseClient(): BaseApiClient {
  if (!instance) {
    const useMock = process.env.BASE_USE_MOCK !== "false";
    instance = useMock ? new MockBaseApiClient() : new RealBaseApiClient();
  }
  return instance;
}
