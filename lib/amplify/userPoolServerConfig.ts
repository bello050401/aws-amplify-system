import { parseAmplifyConfig } from "aws-amplify/utils";
import type { ResourcesConfig } from "aws-amplify";

/** User-pool GraphQL and session checks need JWTs, not temporary AWS keys.
 * Keep the SDK token validation/refresh and AppSync authorization unchanged.
 * Storage operations retain the original config and identity-pool credentials.
 */
export function userPoolServerConfig(input: Parameters<typeof parseAmplifyConfig>[0]): ResourcesConfig {
  const config = parseAmplifyConfig(input);
  if (!config.Auth?.Cognito) return config;
  const cognito = { ...config.Auth.Cognito };
  if (process.env.BELLO_DEVICE_SECURITY === "enforced") {
    if (!process.env.SECURITY_POOL_ID || !process.env.SECURITY_CLIENT_ID) throw new Error("SECURITY_NOT_CONFIGURED");
    cognito.userPoolId = process.env.SECURITY_POOL_ID;
    cognito.userPoolClientId = process.env.SECURITY_CLIENT_ID;
  }
  delete cognito.identityPoolId;
  delete cognito.allowGuestAccess;
  return { ...config, Auth: { ...config.Auth, Cognito: cognito } } as ResourcesConfig;
}
