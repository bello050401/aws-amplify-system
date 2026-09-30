import "server-only";
import { NEXT_ENGINE_STAGING_ORIGIN } from "./diagnosticProbe";

type Deps = {
  enabled: () => boolean;
  origin: () => string | null;
  isAdmin: () => Promise<boolean>;
  probe: () => Promise<boolean>;
};

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};
const result = (ok: boolean, status = 200) => new Response(JSON.stringify({ ok }), { status, headers });

function matchesStagingIngress(request: Request, url: URL): boolean {
  const expectedHost = new URL(NEXT_ENGINE_STAGING_ORIGIN).host;
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (url.origin === NEXT_ENGINE_STAGING_ORIGIN) {
    return (!forwardedHost || forwardedHost === expectedHost) && (!forwardedProto || forwardedProto === "https");
  }
  // Amplify SSR is known to give Next.js an internal localhost:3000 URL. In that
  // one case require both exact proxy fields; never use arbitrary forwarded values.
  return url.origin === "http://localhost:3000" && forwardedHost === expectedHost && forwardedProto === "https";
}

async function hasNoBodyBytes(request: Request): Promise<boolean> {
  if (!request.body) return true;
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Body read timed out")), 2000);
  });
  try {
    // Bounded even for a stream that emits endless empty chunks.
    for (let count = 0; count < 8; count++) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) return true;
      if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength !== 0) return false;
    }
    return false;
  } catch { return false; }
  finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
}

/** No caller-supplied data, ARN, or secret value is accepted. */
export function createNextEngineDiagnosticHandler(deps: Deps) {
  async function POST(request: Request): Promise<Response> {
    if (!deps.enabled() || deps.origin() !== NEXT_ENGINE_STAGING_ORIGIN) return result(false, 404);
    let admin = false;
    try { admin = await deps.isAdmin(); } catch { /* Fail closed. */ }
    if (!admin) return result(false, 403);
    if (request.headers.get("origin") !== NEXT_ENGINE_STAGING_ORIGIN) return result(false, 403);
    const url = new URL(request.url);
    if (!matchesStagingIngress(request, url) || url.pathname !== "/api/next-engine/diagnostic" || url.search ||
        !(await hasNoBodyBytes(request))) return result(false, 400);
    try { return result(await deps.probe()); } catch { return result(false); }
  }
  return { POST, GET: async () => result(false, 405) };
}
