import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { fetchAuthSession } from "aws-amplify/auth/server";
import { runWithAmplifyServerContext } from "./serverUtils";

export type InventoryRole = "ADMIN" | "EDITOR" | "VIEWER";
const INVENTORY_ROLES: InventoryRole[] = ["ADMIN", "EDITOR", "VIEWER"];

export type InventorySessionStatus =
  | { kind: "authorized"; role: InventoryRole }
  | { kind: "signed-in-not-authorized" }
  | { kind: "signed-out" };

/**
 * Inventory's own version of lib/amplify/requireAdmin.ts's getSessionStatus
 * — deliberately a separate function, not a shared/generalized one, because
 * the two systems check membership in unrelated Cognito groups ("Admins"
 * vs. ADMIN/EDITOR/VIEWER) and must keep evolving independently (see the
 * comment in amplify/auth/resource.ts). A signed-in user can be in both
 * worlds' groups at once; each system only ever looks at its own.
 *
 * When a user belongs to more than one Inventory group (e.g. both ADMIN
 * and EDITOR), ADMIN wins — there is no scenario where a user should be
 * treated as less privileged than a group they actually hold.
 */
export async function getInventorySessionStatus(): Promise<InventorySessionStatus> {
  try {
    return await runWithAmplifyServerContext({
      nextServerContext: { cookies },
      operation: async (contextSpec) => {
        const session = await fetchAuthSession(contextSpec);
        if (!session.tokens) return { kind: "signed-out" };
        const groups = (session.tokens.accessToken.payload["cognito:groups"] ?? []) as string[];
        const role = INVENTORY_ROLES.find((r) => groups.includes(r));
        return role ? { kind: "authorized", role } : { kind: "signed-in-not-authorized" };
      },
    });
  } catch {
    return { kind: "signed-out" };
  }
}

export async function getInventoryRole(): Promise<InventoryRole | null> {
  const status = await getInventorySessionStatus();
  return status.kind === "authorized" ? status.role : null;
}

export function canEditInventory(role: InventoryRole | null): boolean {
  return role === "ADMIN" || role === "EDITOR";
}

export function canHardDeleteInventory(role: InventoryRole | null): boolean {
  return role === "ADMIN";
}

/** Identity string for Inventory.createdBy/updatedBy and InventoryHistory.changedBy — email if the token carries one, else the Cognito sub, so a write is never silently attributed to "unknown". */
export async function getCurrentInventoryUserEmail(): Promise<string | null> {
  try {
    return await runWithAmplifyServerContext({
      nextServerContext: { cookies },
      operation: async (contextSpec) => {
        const session = await fetchAuthSession(contextSpec);
        if (!session.tokens) return null;
        const payload = session.tokens.idToken?.payload ?? session.tokens.accessToken.payload;
        return (payload.email as string | undefined) ?? (payload.sub as string | undefined) ?? null;
      },
    });
  } catch {
    return null;
  }
}

/** For use in Route Handlers, mirroring requireAdminOrRedirect in requireAdmin.ts. */
export async function requireInventoryUserOrRedirect(request: Request): Promise<NextResponse | null> {
  const status = await getInventorySessionStatus();
  if (status.kind === "authorized") return null;

  const url = new URL("/inventory/login", request.url);
  if (status.kind === "signed-in-not-authorized") url.searchParams.set("error", "not_authorized");
  return NextResponse.redirect(url);
}
