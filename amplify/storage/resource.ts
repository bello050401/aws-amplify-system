import { defineStorage } from "@aws-amplify/backend";

/**
 * Object storage for the Inventory system (BELLO在庫管理システム, Phase 2).
 *
 * There is no existing Storage resource on this Amplify app — the
 * feature-page generator stores no images of its own (BASE hosts those,
 * see lib/base/*), so this bucket is new and exists solely for Inventory.
 *
 * Everything lives under the `inventory/*` prefix on purpose: if a future
 * system on this same Amplify app ever needs its own storage area, it
 * gets its own prefix (or its own bucket) rather than sharing this one,
 * so its access rules can never accidentally loosen or tighten
 * Inventory's.
 *
 * Access is Cognito User Pool groups only — there is no `guest`/
 * unauthenticated rule at all, matching the Data authorization design in
 * amplify/data/resource.ts (no public access to inventory data or
 * images). ADMIN and EDITOR can manage images; VIEWER can only view them.
 */
export const storage = defineStorage({
  name: "belloInventoryStorage",
  access: (allow) => ({
    "inventory/*": [
      allow.groups(["ADMIN", "EDITOR"]).to(["read", "write", "delete"]),
      allow.groups(["VIEWER"]).to(["read"]),
    ],
  }),
});
