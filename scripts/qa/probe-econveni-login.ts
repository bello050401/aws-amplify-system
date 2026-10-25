import { fromIni } from "@aws-sdk/credential-providers";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { EconveniCredentialStore } from "../../lib/listing/econveni/credentials";
import { EconveniHttpSession, EconveniHttpError } from "../../lib/listing/econveni/httpSession";
async function main() {
  const store = new EconveniCredentialStore(new SecretsManagerClient({ region: "us-west-2", credentials: fromIni({ profile: "Bello" }) }));
  const credentials = await store.credentials();
  if (!credentials) throw new Error("NOT_CONFIGURED");
  const session = new EconveniHttpSession(async (input, init) => {
    const response = await fetch(input, init);
    const url = new URL(String(input));
    const location = response.headers.get("location");
    const redirect = location ? new URL(location, url) : null;
    console.log(JSON.stringify({ method: init?.method, origin: url.origin, path: url.pathname, status: response.status,
      redirectOrigin: redirect?.origin, redirectPath: redirect?.pathname }));
    return response;
  });
  await session.login(credentials);
  const form = await session.registrationForm();
  // Only schema metadata. Never dump page HTML, session cookies, passwords, or hidden values.
  console.log(JSON.stringify({ connected: true, method: form.method, enctype: form.enctype, endpoint: new URL(form.action).pathname,
    hiddenNames: form.fields.filter(f => f.type === "hidden").map(f=>f.name),
    fields: form.fields.filter(f => f.type !== "hidden" && f.type !== "password").map(f => ({ name: f.name, type: f.type, options: f.options })) }, null, 2));
}
void main().catch(e => { console.error(JSON.stringify({ connected: false, code: e instanceof EconveniHttpError ? e.code : "CONNECTION_UNAVAILABLE" })); process.exitCode = 1; });
