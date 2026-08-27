import { defineAuth } from "@aws-amplify/backend";

/**
 * Shared authentication for all BELLO internal systems on this Amplify app
 * (feature-page generator + Inventory, and whatever else joins later).
 *
 * "Admins" is the original feature-page group — kept exactly as-is so the
 * existing `allow.group("Admins")` rules on Feature / FeatureItem /
 * BaseItemCache / BaseOAuthToken keep working unchanged for whoever is
 * already in it. It is NOT reused for Inventory: Inventory needs three
 * distinct permission levels (ADMIN full access, EDITOR create/update,
 * VIEWER read-only — see data/resource.ts), which "Admins" alone can't
 * express. Rather than repurpose or rename it (which would silently change
 * what existing Feature admins can do), we add three new groups alongside
 * it. A person who needs both systems is simply added to both groups —
 * e.g. an existing Feature admin who also runs Inventory gets "Admins" +
 * "ADMIN". Nothing about "Admins" itself changes.
 *
 * Add accounts after deploy with:
 *   npx ampx sandbox --profile <profile>   # for local dev
 *   aws cognito-idp admin-create-user ...  # for a real environment
 * then add them to the relevant group(s) with
 *   aws cognito-idp admin-add-user-to-group --group-name <Admins|ADMIN|EDITOR|VIEWER> ...
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  groups: ["Admins", "ADMIN", "EDITOR", "VIEWER"],
});
