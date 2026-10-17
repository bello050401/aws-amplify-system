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
  delete cognito.identityPoolId;
  delete cognito.allowGuestAccess;
  return { ...config, Auth: { ...config.Auth, Cognito: cognito } } as ResourcesConfig;
}
