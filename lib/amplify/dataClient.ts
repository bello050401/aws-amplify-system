import { cookies } from "next/headers";
import { generateServerClientUsingCookies } from "@aws-amplify/adapter-nextjs/data";
import type { Schema } from "@/amplify/data/resource";
import outputs from "@/amplify_outputs.json";

/**
 * Server-side Amplify Data client for use inside Server Components,
 * Route Handlers, and Server Actions.
 *
 * IMPORTANT: this client does NOT automatically switch auth mode based on
 * whether a Cognito session exists. Every call uses the schema's
 * `defaultAuthorizationMode` ("apiKey") unless `authMode` is passed
 * explicitly per call — Amplify Data has no "use the session if there is
 * one" default. Concretely:
 *   - Reads on Feature / FeatureItem / BaseItemCache carry a public
 *     `allow.publicApiKey().to(["read"])` rule, so the apiKey default is
 *     fine for the public feature page AND happens to still work for
 *     admin reads too.
 *   - Every WRITE on those three models, and every call on
 *     `BaseOAuthToken` (admin-only, no public rule at all), requires
 *     `allow.group("Admins")` — which only a `userPool`-mode call can
 *     satisfy. Use `adminAuthMode` below on all of those, or the call
 *     fails with an authorization error even for a signed-in admin.
 */
export const serverDataClient = generateServerClientUsingCookies<Schema>({
  config: outputs,
  cookies,
});

/** Spread/pass as the options argument on any admin-only Amplify Data call — see the note above. */
export const adminAuthMode = { authMode: "userPool" } as const;
