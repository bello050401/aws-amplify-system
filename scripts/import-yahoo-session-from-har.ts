/** Local operator import to the dedicated staging Secrets Manager secret only.
 * Never stores the HAR, response HTML or credentials in source/build logs.
 * Usage: node --conditions=react-server --import tsx scripts/import-yahoo-session-from-har.ts HAR
 */
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fromIni } from "@aws-sdk/credential-providers";
import { SecretsManagerClient, DescribeSecretCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { YahooWebSession } from "../lib/listing/yahooAuction/webHttpSession";

async function main() {
  const [source, ...extra] = process.argv.slice(2);
  if (!source || extra.length || (await fs.stat(source)).size > 100 * 1024 * 1024) throw Error();
  const credentials = fromIni({profile:"Bello"}), region = "us-west-2";
  const identity = await new STSClient({credentials,region}).send(new GetCallerIdentityCommand({}));
  if (identity.Account !== "203918843421") throw Error();
  const sm = new SecretsManagerClient({credentials,region});
  const meta = await sm.send(new DescribeSecretCommand({SecretId:"bello/yahoo-web-session-staging"}));
  if (!meta.ARN || !/^arn:aws:secretsmanager:us-west-2:203918843421:secret:bello\/yahoo-web-session-staging-[A-Za-z0-9]+$/.test(meta.ARN) || meta.DeletedDate) throw Error();
  const opened = YahooWebSession.fromHar(JSON.parse((await fs.readFile(source,"utf8")).replace(/^\uFEFF/,"")));
  if (!opened.ok) { console.log(JSON.stringify(opened)); process.exitCode=1; return; }
  const result = await opened.value.persistVerifiedSession(async value => {
    await sm.send(new PutSecretValueCommand({SecretId:meta.ARN,ClientRequestToken:randomUUID(),SecretString:value}));
  });
  console.log(JSON.stringify({ok:result.ok,...(result.ok?{target:"YAHOO_STAGING_ONLY",verifiedLocally:true,cloudExecutionVerified:false}:{code:result.code})}));
  if (!result.ok) process.exitCode=1;
}
main().catch(()=>{console.log(JSON.stringify({ok:false,code:"SESSION_IMPORT_NOT_CONFIRMED"}));process.exitCode=1;});
