import { defineAuth } from "@aws-amplify/backend";

/**
 * Admin-only authentication for the feature-page generator.
 *
 * This system has exactly one kind of authenticated user: shop staff who
 * operate the admin screens (search → select → generate → publish).
 * Public visitors never sign in — published feature pages are read with
 * unauthenticated (public API key) access, wired up in `data/resource.ts`.
 *
 * Add admin accounts after the first deploy with:
 *   npx ampx sandbox --profile <profile>   # for local dev
 *   aws cognito-idp admin-create-user ...  # for a real environment
 * then add them to the "Admins" group so they satisfy the `groups: ["Admins"]`
 * authorization rules on the Feature / FeatureItem models.
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  groups: ["Admins"],
});
