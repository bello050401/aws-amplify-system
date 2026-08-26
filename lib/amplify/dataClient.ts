import { cookies } from "next/headers";
import { generateServerClientUsingCookies } from "@aws-amplify/adapter-nextjs/data";
import type { Schema } from "@/amplify/data/resource";
import outputs from "@/amplify_outputs.json";

/**
 * Server-side Amplify Data client for use inside Server Components,
 * Route Handlers, and Server Actions. Reads the caller's Cognito session
 * from cookies when present (admin screens), and otherwise falls back to
 * the public API key auth mode configured on Feature / FeatureItem /
 * BaseItemCache — which is exactly what the public feature-page route
 * needs, with no login required.
 */
export const serverDataClient = generateServerClientUsingCookies<Schema>({
  config: outputs,
  cookies,
});
