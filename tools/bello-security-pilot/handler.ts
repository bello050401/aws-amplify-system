import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DynamoSecurityStore } from "../../lib/security/awsStore";
import { KmsVault } from "../../lib/security/awsVault";
import { CognitoProvider } from "../../lib/security/cognito";
import { SecurityService } from "../../lib/security/service";
import { securityHttp, SECURITY_HEADERS } from "../../lib/security/http";

let service: SecurityService | undefined;
async function getService() {
  if (service) return service;
  const region = process.env.AWS_REGION!;
  const secret = await new SecretsManagerClient({ region }).send(new GetSecretValueCommand({ SecretId: process.env.SECURITY_CLIENT_SECRET_ARN }));
  const credentials = JSON.parse(secret.SecretString ?? "{}");
  if (typeof credentials.clientSecret !== "string" || credentials.clientSecret.length < 16) throw new Error("NOT_CONFIGURED");
  service = new SecurityService(new DynamoSecurityStore(process.env.SECURITY_TABLE!, region),
    new KmsVault(process.env.SECURITY_KEY_ARN!, region, process.env.SECURITY_DEPLOYMENT!),
    new CognitoProvider(process.env.SECURITY_POOL_ID!, process.env.SECURITY_CLIENT_ID!, region, credentials.clientSecret), process.env.SECURITY_ORIGIN!);
  return service;
}
type Event = { rawPath: string; body?: string; isBase64Encoded?: boolean; headers: Record<string, string>; cookies?: string[]; requestContext: { http: { method: string; sourceIp: string } } };
export async function handler(event: Event) {
  if (event.requestContext.http.method === "GET" && ["/", "/security"].includes(event.rawPath))
    return { statusCode: 200, headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), publickey-credentials-get=(self), publickey-credentials-create=(self)" },
      body: readFileSync(join(__dirname, "index.html"), "utf8") };
  if (event.requestContext.http.method === "GET" && ["/app.js", "/app.css"].includes(event.rawPath)) return {
    statusCode: 200, headers: { ...SECURITY_HEADERS, "content-type": event.rawPath.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8" },
    body: readFileSync(join(__dirname, event.rawPath.slice(1)), "utf8"),
  };
  if (event.requestContext.http.method === "GET" && event.rawPath === "/health") return {
    statusCode: 200, headers: SECURITY_HEADERS, body: JSON.stringify({ environment: "isolated-security-pilot", businessDataConnected: false }),
  };
  try {
    return await securityHttp(await getService(), {
      method: event.requestContext.http.method, path: event.rawPath,
      headers: { ...event.headers, cookie: event.cookies?.join("; ") ?? event.headers.cookie },
      body: event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString() : event.body ?? "",
      // Trusted API Gateway metadata, not attacker-provided X-Forwarded-For.
      ip: event.requestContext.http.sourceIp,
    });
  } catch {
    return { statusCode: 503, headers: SECURITY_HEADERS, body: JSON.stringify({ error: "SECURITY_UNAVAILABLE" }) };
  }
}
