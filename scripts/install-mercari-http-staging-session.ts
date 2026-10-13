import { readFileSync, statSync } from "node:fs";
import { fromIni } from "@aws-sdk/credential-providers";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { SecretsManagerClient, DescribeSecretCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { sessionFromProvidedHar } from "../lib/listing/mercariBridge/webHttpHarSession.ts";
import { openMercariWebHttpCookieReadOnly } from "../lib/listing/mercariBridge/webHttpReadOnlyClient.ts";
import { WEB_HTTP_SHOP_ID } from "../lib/listing/mercariBridge/webHttpDraftJob.ts";

/** Operator-only import of the user-provided capture. No browser access, logging
 * of session material, refresh guessing, deployment, or Shops mutations.
 */
async function main() {
  const source = process.argv[2];
  if (!source || process.argv.length !== 3 || statSync(source).size > 100 * 1024 * 1024)
    throw Error("INVALID_SOURCE");
  const session = sessionFromProvidedHar(JSON.parse(readFileSync(source, "utf8")));
  if (!session) { console.log(JSON.stringify({status:"FRESH_SESSION_REQUIRED"})); return; }
  const opened = await openMercariWebHttpCookieReadOnly(session);
  if (!opened.client || !(await opened.client.verifyTargetShop()).shopMatched) {
    console.log(JSON.stringify({status:"AUTH_OR_SHOP_UNVERIFIED"})); return;
  }
  const options = { region: "us-west-2", credentials: fromIni({profile:"Bello"}) };
  const identity = await new STSClient(options).send(new GetCallerIdentityCommand({}));
  if (identity.Account !== "203918843421") throw Error("WRONG_ENVIRONMENT");
  const store = new SecretsManagerClient(options);
  const target = await store.send(new DescribeSecretCommand({SecretId:"bello/mercari-web-session-staging"}));
  if (!target.ARN || !/^arn:aws:secretsmanager:us-west-2:203918843421:secret:bello\/mercari-web-session-staging-[A-Za-z0-9]+$/.test(target.ARN))
    throw Error("WRONG_ENVIRONMENT");
  if (session.expiresAtMs <= Date.now() + 60_000) throw Error("EXPIRED_DURING_CHECK");
  await store.send(new PutSecretValueCommand({SecretId:target.ARN, SecretString:JSON.stringify({
    schemaVersion:1, shopId:WEB_HTTP_SHOP_ID, authenticatedAt:new Date().toISOString(),
    expiresAt:new Date(session.expiresAtMs).toISOString(),
    opaqueMaterial:JSON.stringify({cookieHeader:session.cookieHeader}),
  })}));
  console.log(JSON.stringify({status:"STAGING_SESSION_INSTALLED", expiresAt:new Date(session.expiresAtMs).toISOString()}));
}
main().catch(() => { console.log(JSON.stringify({status:"IMPORT_UNAVAILABLE"})); process.exitCode=1; });
