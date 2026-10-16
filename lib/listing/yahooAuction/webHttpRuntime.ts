import "server-only";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import outputs from "../../../amplify_outputs.json";
import { YahooWebSession } from "./webHttpSession";

type Config = { region: string; secretArn: string };
export function yahooRuntimeConfig(): Config | null {
  const c = (outputs as unknown as {custom?: {yahooHttps?: Config}}).custom?.yahooHttps;
  return c?.region === "us-west-2" &&
    /^arn:aws:secretsmanager:us-west-2:203918843421:secret:bello\/yahoo-web-session-staging-[A-Za-z0-9]+$/.test(c.secretArn) ? c : null;
}
export async function readYahooRuntimeSession(): Promise<
  { ok: true; session: YahooWebSession } | { ok: false; code: "NOT_CONFIGURED" | "AUTH_REQUIRED" | "SESSION_UNAVAILABLE" }> {
  const c = yahooRuntimeConfig();
  if (!c) return { ok: false, code: "NOT_CONFIGURED" };
  try {
    const sm = new SecretsManagerClient({region:c.region});
    const result = await sm.send(new GetSecretValueCommand({SecretId:c.secretArn,VersionStage:"AWSCURRENT"}));
    const opened = YahooWebSession.fromStoredSession(result.SecretString ?? "");
    return opened.ok ? {ok:true,session:opened.value} : {ok:false,code:"AUTH_REQUIRED"};
  } catch { return {ok:false,code:"SESSION_UNAVAILABLE"}; }
}
