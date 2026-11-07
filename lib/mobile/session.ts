import { getVerifiedInventoryAccess, type InventoryRole } from "@/lib/amplify/requireInventoryUser";
import { mobileFeaturesForGroups, type MobileFeature, type MobileFeatures } from "./accessPolicy";

export type MobileSessionResult =
  | { ok: true; owner: string; role: InventoryRole; features: MobileFeatures }
  | { ok: false; status: 401 | 403 | 503; error: string };

/** No email/name matching, client flags, or unverified JWT decoding is an authorization source. */
export async function getMobileSession(): Promise<MobileSessionResult> {
  const staff = await getVerifiedInventoryAccess();
  if (staff.kind !== "authorized") {
    const status = staff.kind === "temporarily-unavailable" ? 503 : staff.kind === "signed-in-not-authorized" ? 403 : 401;
    return { ok: false, status, error: status === 503 ? "AUTH_UNAVAILABLE" : status === 403 ? "FORBIDDEN" : "SIGN_IN_REQUIRED" };
  }
  if (!staff.owner) return { ok: false, status: 401, error: "SIGN_IN_REQUIRED" };
  if (!Array.isArray(staff.groups) || !staff.groups.every(group => typeof group === "string") || !staff.groups.includes(staff.role)) {
    return { ok: false, status: 403, error: "FORBIDDEN" };
  }
  return { ok: true, owner: staff.owner, role: staff.role, features: mobileFeaturesForGroups(staff.groups) };
}

/** Mobile EC/sales handlers must call this before reading data or performing any operation. */
export async function requireMobileFeature(feature: MobileFeature): Promise<MobileSessionResult> {
  const session = await getMobileSession();
  if (!session.ok || session.features[feature] === true) return session;
  return { ok: false, status: 403, error: "FEATURE_FORBIDDEN" };
}
