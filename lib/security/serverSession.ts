import { cache } from "react";
import { cookies, headers } from "next/headers";
import outputs from "@/amplify_outputs.json";
import { COOKIE } from "./http";
import { GRANT_HEADER, readServerGrant } from "./serverGrant";
import { deviceSecurityEnabled, securityRuntime } from "./serverRuntime";
import {serverCookieBridge} from './serverCookieBridge';

// Next provides request-scoped React cache. Pure import/export jobs can load
// this module under React 18 outside RSC, where cache is absent. In that case
// do not memoize anything: every invocation still performs the same checks.
const requestCache: typeof cache = typeof cache === "function" ? cache : fn => fn;
export const approvedServerSession = requestCache(async () => {
  if (!deviceSecurityEnabled()) return null;
  const [jar, h] = await Promise.all([cookies(), headers()]);
  if (!h.has(GRANT_HEADER)) return null;
  const runtime = await securityRuntime();
  const token=jar.get(COOKIE)?.value??"";
  const grant=readServerGrant(h.get(GRANT_HEADER), token, runtime.contextKey);
  return {...grant,tokens:await runtime.service.serverTokens(token,grant)};
});

/** A read-only server cookie adapter for the existing Amplify business code.
 * Verified Cognito tokens are adapted in memory, never written to a browser. */
export async function businessCookies(): Promise<Awaited<ReturnType<typeof cookies>>> {
  if (!deviceSecurityEnabled()) return cookies();
  const grant = await approvedServerSession();
  // Deliberately no refreshToken: refresh is serialized in SecurityService.
  return serverCookieBridge(process.env.SECURITY_CLIENT_ID || outputs.auth.user_pool_client_id,grant) as unknown as Awaited<ReturnType<typeof cookies>>;
}
