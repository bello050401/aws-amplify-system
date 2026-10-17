import { cookies } from "next/headers";
import { fetchAuthSession } from "aws-amplify/auth/server";
import { runWithAmplifyServerContext } from "@/lib/amplify/serverUtils";
import { getInventorySessionStatus, type InventoryRole } from "@/lib/amplify/requireInventoryUser";
import { mobileFeaturesForGroups, type MobileFeature, type MobileFeatures } from "./accessPolicy";

export type MobileSessionResult =
  | { ok: true; owner: string; role: InventoryRole; features: MobileFeatures }
  | { ok: false; status: 401 | 403 | 503; error: string };

/** No email/name matching, client flags, or unverified JWT decoding is an authorization source. */
export async function getMobileSession(): Promise<MobileSessionResult> {
  const staff = await getInventorySessionStatus();
  if (staff.kind !== "authorized") {
    const status = staff.kind === "temporarily-unavailable" ? 503 : staff.kind === "signed-in-not-authorized" ? 403 : 401;
    return { ok: false, status, error: status === 503 ? "AUTH_UNAVAILABLE" : status === 403 ? "FORBIDDEN" : "SIGN_IN_REQUIRED" };
  }
  try {
    return await runWithAmplifyServerContext({ nextServerContext: { cookies }, operation: async context => {
      const session = await fetchAuthSession(context);
      const payload = session.tokens?.accessToken.payload;
      const groups = payload?.["cognito:groups"];
      if (!payload || typeof payload.sub !== "string" || !payload.sub) return { ok: false, status: 401, error: "SIGN_IN_REQUIRED" };
      if (!Array.isArray(groups) || !groups.every(group => typeof group === "string") || !groups.includes(staff.role)) {
        return { ok: false, status: 403, error: "FORBIDDEN" };
      }
      return { ok: true, owner: payload.sub, role: staff.role, features: mobileFeaturesForGroups(groups) };
    } });
  } catch { return { ok: false, status: 503, error: "AUTH_UNAVAILABLE" }; }
}

/** Mobile EC/sales handlers must call this before reading data or performing any operation. */
export async function requireMobileFeature(feature: MobileFeature): Promise<MobileSessionResult> {
  const session = await getMobileSession();
  if (!session.ok || session.features[feature] === true) return session;
  return { ok: false, status: 403, error: "FEATURE_FORBIDDEN" };
}
