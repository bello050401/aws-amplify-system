import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { NodeNextRequest } from "next/dist/server/base-http/node";
import { addRequestMeta } from "next/dist/server/request-meta";
import { NextRequestAdapter } from "next/dist/server/web/spec-extension/adapters/next-request";
import { createNextEngineDiagnosticHandler } from "../lib/listing/nextEngine/diagnosticHandler";
import { NEXT_ENGINE_STAGING_ORIGIN } from "../lib/listing/nextEngine/diagnosticProbe";

let enabled = false;
let admin = true;
let probeCalls = 0;
const handler = createNextEngineDiagnosticHandler({
  enabled: () => enabled,
  origin: () => NEXT_ENGINE_STAGING_ORIGIN,
  isAdmin: async () => admin,
  probe: async () => { probeCalls++; return true; },
});
const url = `${NEXT_ENGINE_STAGING_ORIGIN}/api/next-engine/diagnostic`;
const post = (origin?: string, body?: string, path = url, proxy?: Record<string, string>) => new Request(path, {
  method: "POST", headers: { ...(origin === undefined ? {} : { Origin: origin }), ...proxy }, body,
});

async function adaptedPost(body: string): Promise<{ status: number; json: unknown; streamPresent: boolean }> {
  let streamPresent = false;
  const server = createServer(async (incoming, outgoing) => {
    try {
      addRequestMeta(incoming, "initURL", "http://localhost:3000");
      const adapted = NextRequestAdapter.fromNodeNextRequest(new NodeNextRequest(incoming), AbortSignal.timeout(5000));
      streamPresent = adapted.body !== null;
      const response = await handler.POST(adapted);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(await response.text());
    } catch { outgoing.writeHead(500); outgoing.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const result = await new Promise<{ status: number; json: unknown }>((resolve, reject) => {
      const req = httpRequest(`http://127.0.0.1:${address.port}/api/next-engine/diagnostic`, {
        method: "POST", headers: {
          Origin: NEXT_ENGINE_STAGING_ORIGIN,
          "x-forwarded-host": new URL(url).host,
          "x-forwarded-proto": "https",
          "Content-Length": Buffer.byteLength(body),
        },
      }, response => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          try { resolve({ status: response.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString()) }); }
          catch (error) { reject(error); }
        });
      });
      req.on("error", reject);
      req.end(body);
    });
    return { ...result, streamPresent };
  } finally { server.close(); }
}

async function main() {
  const disabled = await handler.POST(post(NEXT_ENGINE_STAGING_ORIGIN));
  assert.equal(disabled.status, 404);
  assert.deepEqual(await disabled.json(), { ok: false });
  assert.equal(probeCalls, 0);
  enabled = true;
  for (const request of [post(), post("null"), post("https://other.example.test"),
    post(NEXT_ENGINE_STAGING_ORIGIN, "arbitrary-data"), post(NEXT_ENGINE_STAGING_ORIGIN, undefined, `${url}?arn=arbitrary`),
    post(NEXT_ENGINE_STAGING_ORIGIN, undefined, "https://other.example.test/api/next-engine/diagnostic"),
    post(NEXT_ENGINE_STAGING_ORIGIN, undefined, "http://localhost:3000/api/next-engine/diagnostic"),
    post(NEXT_ENGINE_STAGING_ORIGIN, undefined, "http://localhost:3000/api/next-engine/diagnostic", {
      "x-forwarded-host": "other.example.test", "x-forwarded-proto": "https",
    }),
    post(NEXT_ENGINE_STAGING_ORIGIN, undefined, "http://localhost:3000/api/next-engine/diagnostic", {
      "x-forwarded-host": new URL(url).host, "x-forwarded-proto": "http",
    })]) {
    const response = await handler.POST(request);
    assert.deepEqual(await response.json(), { ok: false });
  }
  assert.equal(probeCalls, 0, "No arbitrary input or mismatched Origin may reach the probe");
  admin = false;
  assert.deepEqual(await (await handler.POST(post(NEXT_ENGINE_STAGING_ORIGIN))).json(), { ok: false });
  admin = true;
  assert.deepEqual(await (await handler.GET()).json(), { ok: false });
  const response = await handler.POST(post(NEXT_ENGINE_STAGING_ORIGIN));
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(probeCalls, 1);
  const internal = await handler.POST(post(NEXT_ENGINE_STAGING_ORIGIN, undefined,
    "http://localhost:3000/api/next-engine/diagnostic", {
      "x-forwarded-host": new URL(url).host, "x-forwarded-proto": "https",
    }));
  assert.deepEqual(await internal.json(), { ok: true });
  assert.equal(probeCalls, 2);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  const emptyAdapter = await adaptedPost("");
  assert.deepEqual(emptyAdapter, { status: 200, json: { ok: true }, streamPresent: true });
  assert.equal(probeCalls, 3);
  const nonemptyAdapter = await adaptedPost("x");
  assert.deepEqual(nonemptyAdapter, { status: 400, json: { ok: false }, streamPresent: true });
  assert.equal(probeCalls, 3);
  console.log("Next Engine diagnostic handler: disabled by default, ADMIN and exact Origin, no caller data, boolean result passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
