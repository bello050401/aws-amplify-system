import type { BaseApiClient } from "./client";
import { MockBaseApiClient } from "./client.mock";
import { RealBaseApiClient } from "./client.real";

export type { BaseApiClient } from "./client";
export { BaseApiError } from "./client";
export * from "./types";

let instance: BaseApiClient | null = null;

/**
 * Single entry point every route/component should import instead of
 * reaching for MockBaseApiClient / RealBaseApiClient directly.
 * `BASE_USE_MOCK=true` forces the mock regardless of other config.
 * Otherwise, missing BASE_CLIENT_ID/SECRET falls back to the mock with a
 * warning (so local dev without any BASE setup still works) rather than
 * throwing on every request.
 */
export function getBaseClient(): BaseApiClient {
  if (!instance) {
    const forceMock = process.env.BASE_USE_MOCK === "true";
    const hasCredentials = Boolean(process.env.BASE_CLIENT_ID && process.env.BASE_CLIENT_SECRET);

    if (forceMock || !hasCredentials) {
      if (!forceMock) {
        console.warn(
          "[lib/base] BASE_CLIENT_ID / BASE_CLIENT_SECRET is not set — falling back to the mock BASE client.",
        );
      }
      instance = new MockBaseApiClient();
    } else {
      instance = new RealBaseApiClient();
    }
  }
  return instance;
}
