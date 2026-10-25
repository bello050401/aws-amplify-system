import { defineStorage } from "@aws-amplify/backend";

/**
 * Inventory and internal knowledge images are never public.
 *
 * Admins is the independent feature-page CMS role, not inventory ADMIN.
 * Identity Pool selects ONE role by precedence. auth/resource.ts therefore
 * places ADMIN/EDITOR/VIEWER before Admins, so mixed-role staff retain their
 * inventory rights without granting those rights to a CMS-only account.
 * Deploy precedence and policy changes together. Already-issued temporary
 * IAM credentials must be considered when verifying revocation/cutover.
 */
export const storage = defineStorage({
  name: "belloInventoryStorage",
  access: (allow) => ({
    "inventory/*": [
      allow.groups(["ADMIN", "EDITOR"]).to(["read", "write", "delete"]),
      allow.groups(["VIEWER"]).to(["read"]),
    ],
    // Knowledge originals are ADMIN-only. EDITOR/VIEWER use permitted search
    // data through the application, not direct access to these documents.
    "knowledge/*": [allow.groups(["ADMIN"]).to(["read", "write", "delete"])],
  }),
});
