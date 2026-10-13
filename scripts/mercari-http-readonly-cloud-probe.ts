import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { WEB_HTTP_SHOP_ID } from "../lib/listing/mercariBridge/webHttpDraftJob.ts";
import { probeMercariWebHttpProductRead } from "../lib/listing/mercariBridge/webHttpReadOnlyProbe.ts";

/** Temporary staging Lambda. IAM invocation only; no Function URL or schedules.
 * Its role may read just the dedicated probe secret. Never accepts credentials,
 * target IDs, URLs or queries from an invocation payload. No console logging.
 */
export async function handler() {
  const base = { environment: "AWS_LAMBDA_HTTPS", checkedAt: new Date().toISOString() };
  const secretArn = process.env.MERCARI_HTTP_PROBE_SECRET_ARN;
  const productId = process.env.MERCARI_HTTP_PROBE_PRODUCT_ID;
  if (!secretArn || !/^arn:aws:secretsmanager:us-west-2:\d{12}:secret:bello\/mercari-web-session-staging-probe-[A-Za-z0-9]+$/
      .test(secretArn) || !productId || !/^[A-Za-z0-9]{1,64}$/.test(productId))
    return { ...base, status: "PROBE_CONFIG_UNAVAILABLE" };
  try {
    const client = new SecretsManagerClient({ region: "us-west-2" });
    const secret = await client.send(new GetSecretValueCommand({ SecretId: secretArn,
      VersionStage: "AWSCURRENT" }));
    const session = JSON.parse(secret.SecretString ?? "null");
    if (!session || session.schemaVersion !== 1 || session.shopId !== WEB_HTTP_SHOP_ID ||
        typeof session.cookieHeader !== "string" ||
        !Number.isSafeInteger(session.expiresAtMs) || session.expiresAtMs <= Date.now())
      return { ...base, status: "AUTH_REQUIRED" };
    const result = await probeMercariWebHttpProductRead(session, productId);
    return { ...base, ...result };
  } catch { return { ...base, status: "PROBE_UNAVAILABLE" }; }
}
