import "server-only";
import type { NextEngineAppConfiguration } from "./appConfiguration";
import type { NextEngineTokenPair } from "./tokenStore";

type Launch = NextEngineAppConfiguration & { uid: string; state: string };
type OutcomeStage = "origin" | "launch" | "origin_check" | "configuration" | "preflight" |
  "exchange" | "verify_before_save" | "save" | "readback" | "verify_after_save" | "completed";
type Deps = {
  origin: () => string | null;
  isAdmin: () => Promise<boolean>;
  configuration: () => Promise<NextEngineAppConfiguration | null>;
  complete: (input: Launch, actions: {
    preflight: () => Promise<unknown>;
    exchange: (value: Launch) => Promise<NextEngineTokenPair>;
    verifyConfiguration: () => Promise<NextEngineAppConfiguration | null>;
    save: (tokens: NextEngineTokenPair) => Promise<void>;
    readBack: () => Promise<NextEngineTokenPair | null>;
  }) => Promise<void>;
  preflight: (binding: NextEngineAppConfiguration) => Promise<unknown>;
  exchange: (input: Launch) => Promise<NextEngineTokenPair>;
  save: (tokens: NextEngineTokenPair, binding: NextEngineAppConfiguration) => Promise<void>;
  readBack: (binding: NextEngineAppConfiguration) => Promise<NextEngineTokenPair | null>;
  report?: (result: "success" | "failed", stage: OutcomeStage) => void;
};

const securityHeaders = {
  "Cache-Control": "no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};
const confirmationHeaders = { ...securityHeaders, "Referrer-Policy": "strict-origin" };

export function configuredNextEngineOrigin(raw = process.env.NEXT_ENGINE_PUBLIC_ORIGIN): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && raw === url.origin ? raw : null;
  } catch { return null; }
}

function redirect(origin: string, path: string): Response {
  return new Response(null, { status: 303, headers: { ...securityHeaders, Location: `${origin}${path}` } });
}

const confirmation = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>ネクストエンジン接続確認</title></head><body><main><h1>ネクストエンジン接続確認</h1><p>BELLOにネクストエンジンの商品情報連携を接続します。</p><p>ご自身で接続を始めた場合だけ続けてください。</p><form method="post"><button type="submit">接続する</button></form></main></body></html>`;
const settingsPath = (result: "success" | "failed") => `/inventory/settings?tab=nextEngine&ne_result=${result}`;

/** GET displays a static confirmation; only a same-origin ADMIN POST consumes the launch state. */
export function createNextEngineCallbackHandlers(deps: Deps) {
  function report(result: "success" | "failed", stage: OutcomeStage): void {
    try {
      if (deps.report) deps.report(result, stage);
      else console.info("[next_engine_callback_result]", JSON.stringify({ result, stage }));
    } catch { /* Status reporting must never change callback behavior. */ }
  }
  async function handle(request: Request, method: "GET" | "POST"): Promise<Response> {
    const origin = deps.origin();
    if (!origin) {
      if (method === "POST") report("failed", "origin");
      return new Response("設定待ち", { status: 503, headers: securityHeaders });
    }
    let admin = false;
    try { admin = await deps.isAdmin(); } catch { /* Fail closed with the same protected response headers. */ }
    if (!admin) return redirect(origin, "/inventory/login");
    const url = new URL(request.url);
    const uid = url.searchParams.get("uid");
    const state = url.searchParams.get("state");
    if (!uid || !state) {
      if (method === "POST") report("failed", "launch");
      return redirect(origin, settingsPath("failed"));
    }
    if (method === "GET") {
      return new Response(confirmation, { status: 200, headers: { ...confirmationHeaders, "Content-Type": "text/html; charset=utf-8" } });
    }
    if (request.headers.get("origin") !== origin) {
      report("failed", "origin_check");
      return redirect(origin, settingsPath("failed"));
    }
    let stage: OutcomeStage = "configuration";
    try {
      const config = await deps.configuration();
      if (!config) throw new Error("Missing configuration");
      let verificationCount = 0;
      await deps.complete({ ...config, uid, state }, {
        preflight: () => { stage = "preflight"; return deps.preflight(config); },
        exchange: value => { stage = "exchange"; return deps.exchange(value); },
        verifyConfiguration: () => {
          stage = verificationCount++ === 0 ? "verify_before_save" : "verify_after_save";
          return deps.configuration();
        },
        save: tokens => { stage = "save"; return deps.save(tokens, config); },
        readBack: () => { stage = "readback"; return deps.readBack(config); },
      });
      report("success", "completed");
      return redirect(origin, settingsPath("success"));
    } catch {
      report("failed", stage);
      return redirect(origin, settingsPath("failed"));
    }
  }
  return { GET: (request: Request) => handle(request, "GET"), POST: (request: Request) => handle(request, "POST") };
}
