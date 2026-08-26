import { defineBackend } from "@aws-amplify/backend";
import { auth } from "./auth/resource";
import { data } from "./data/resource";

/**
 * Amplify Gen2 backend definition.
 *
 * Phase 1 scope: Auth (admin login) + Data (Feature / FeatureItem /
 * BaseItemCache). The BASE API and AI provider integrations run as
 * server-side Next.js route handlers (see app/api/**) rather than as
 * Amplify Functions, so secrets (BASE_CLIENT_SECRET, ANTHROPIC_API_KEY,
 * etc.) live in the Next.js server runtime's environment, never in the
 * client bundle and never in this backend definition.
 */
defineBackend({
  auth,
  data,
});
