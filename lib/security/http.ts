import { SecurityService } from "./service";
import { SecurityError, type Context, type Proof } from "./types";

export const COOKIE = "__Host-bello-session";
export const SECURITY_HEADERS = {
  "cache-control": "no-store, private, max-age=0", pragma: "no-cache",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000",
};
export type HttpRequest = { method: string; path: string; headers: Record<string, string | undefined>; body: string; ip: string };
export type HttpResult = { statusCode: number; headers: Record<string, string>; body: string; cookies?: string[] };
const response = (statusCode: number, value: unknown): HttpResult => ({ statusCode, headers: SECURITY_HEADERS, body: JSON.stringify(value) });
export async function securityHttp(service: SecurityService, req: HttpRequest): Promise<HttpResult> {
  const ctx: Context = { origin: req.headers.origin ?? "", ip: req.ip, userAgent: req.headers["user-agent"] ?? "" };
  try {
    if (req.method !== "POST") throw new SecurityError("METHOD_NOT_ALLOWED", 405);
    if (ctx.origin !== service.origin || !req.headers["content-type"]?.startsWith("application/json") ||
      req.headers["sec-fetch-site"] === "cross-site") throw new SecurityError("INVALID_ORIGIN");
    if (Buffer.byteLength(req.body) > 49152) throw new SecurityError("REQUEST_TOO_LARGE", 413);
    const body = JSON.parse(req.body);
    const token = (req.headers.cookie ?? "").split(";").map(x => x.trim()).find(x => x.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1) ?? "";
    if (req.path === "/api/security/login" || req.path === "/api/security/finish") {
      const result = req.path.endsWith("/login") ? await service.begin(body, ctx) : await service.finish(String(body.flowToken ?? ""), body.answer, ctx);
      const { sessionToken, ...safe } = result;
      const out = response(200, safe);
      if (sessionToken) out.cookies = [COOKIE + "=" + sessionToken + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=" + ("maxAge" in result ? result.maxAge : 900)];
      return out;
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new SecurityError("SIGN_IN_REQUIRED", 401);
    if (req.path === "/api/security/challenge") return response(200, await service.challenge(token, body.digest, ctx));
    if (req.path !== "/api/security/action") throw new SecurityError("NOT_FOUND", 404);
    if (typeof body.payload !== "string" || !body.proof || typeof body.proof.challengeId !== "string" || typeof body.proof.signature !== "string")
      throw new SecurityError("INVALID_REQUEST", 400);
    const result = await service.perform(token, body.payload, body.proof as Proof, ctx);
    const out = response(200, result);
    if (JSON.parse(body.payload).action === "logout") out.cookies = [COOKIE + "=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"];
    return out;
  } catch (e) {
    const error = e instanceof SecurityError ? e : new SecurityError(e instanceof SyntaxError ? "INVALID_JSON" : "SECURITY_UNAVAILABLE", e instanceof SyntaxError ? 400 : 503);
    // A separate metadata-only audit event; failed auditing never allows access.
    try { await service.audit("REQUEST_DENIED", ctx, error.code); } catch { /* response remains fail-closed */ }
    return response(error.status, { error: error.code });
  }
}
