import { SecurityError } from "./types";

export type BusinessScope = "inventory" | "featureCms" | "staffSecurity";
export type BusinessOperation = "read" | "write" | "admin";

/** Roles are intentionally NOT collapsed: legacy Admins and inventory ADMIN are different. */
export function hasBusinessPermission(groups: readonly string[], scope: BusinessScope, operation: BusinessOperation): boolean {
  if (scope === "featureCms") return groups.includes("Admins");
  if (scope === "staffSecurity") return groups.includes("ADMIN");
  if (scope !== "inventory") return false;
  if (operation === "admin") return groups.includes("ADMIN");
  if (operation === "write") return groups.includes("ADMIN") || groups.includes("EDITOR");
  return operation === "read" && groups.some(g => ["ADMIN", "EDITOR", "VIEWER"].includes(g));
}

/** Required for a future business adapter, in addition to device/session/proof checks. */
export function requireBusinessPermission(groups: readonly string[], scope: BusinessScope, operation: BusinessOperation) {
  if (!hasBusinessPermission(groups, scope, operation)) throw new SecurityError("BUSINESS_ROLE_REQUIRED");
}
