import { createHash,randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, SECURITY_HEADERS } from "./http";
import { securityRuntime } from "./serverRuntime";
import { GRANT_HEADER, issueServerGrant } from "./serverGrant";
import { hash } from "./crypto";
import { SecurityError } from "./types";
import { protectedBusinessPath } from "./routes";
import type { RequestProof } from "./requestProof";
import {businessContentPolicy} from './contentPolicy';
import {trustedSourceIp} from './sourceIp';
import {oauthReturnLanding} from './oauthReturn';
import {checkBusinessOrigin,securityReturnUrl} from './businessOrigin';

export async function approvedDeviceBoundary(request: NextRequest) {
  // Never propagate a caller-supplied grant, even on a public route.
  const upstream = new Headers(request.headers);
  upstream.delete(GRANT_HEADER);
  if (!protectedBusinessPath(request.nextUrl.pathname)) return NextResponse.next({ request: { headers: upstream } });
  const oauthLanding=oauthReturnLanding(request);
  if(oauthLanding)return oauthLanding;
  try {
    const { service, contextKey } = await securityRuntime();
    checkBusinessOrigin(request.headers, service.origin);
    const rawProof = request.headers.get("x-bello-device-proof");
    if (!rawProof || rawProof.length > 2048) throw new SecurityError("DEVICE_PROOF_REQUIRED", 401);
    let proof: RequestProof;
    try { proof = JSON.parse(rawProof); } catch { throw new SecurityError("INVALID_DEVICE_PROOF"); }
    // Body verification is also required for Server Actions and multipart requests.
    const digest = createHash("sha256");
    const reader = request.clone().body?.getReader();
    let length = 0;
    if (reader) for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 32 * 1024 * 1024) { await reader.cancel(); throw new SecurityError("REQUEST_TOO_LARGE", 413); }
      digest.update(chunk.value);
    }
    const token = request.cookies.get(COOKIE)?.value ?? "";
    const actor = await service.authorizeRequest(token, { method: request.method, target: request.nextUrl.pathname + request.nextUrl.search,
      digest: digest.digest("base64url"), proof }, { origin: service.origin,
      // Hosting must supply a trusted origin source; caller X-Forwarded-For is NOT evidence.
      ip: trustedSourceIp(request.headers), userAgent: request.headers.get("user-agent") ?? "",target:request.nextUrl.pathname,method:request.method });
    // APIs retain their own existing operation-specific role checks. CMS-only
    // Admins must not be mistaken for inventory ADMIN, or denied their CMS APIs.
    if(!request.nextUrl.pathname.startsWith("/api/"))
      service.requireBusinessPermission(actor.groups, request.nextUrl.pathname.startsWith("/admin") ? "featureCms" : "inventory", "read");
    upstream.set(GRANT_HEADER, issueServerGrant({ at: service.now(), binding: hash(token), sub: actor.sub,
      username: actor.username, groups: actor.groups, deviceId: actor.deviceId }, contextKey));
    upstream.delete("x-bello-device-proof");
    const csp=request.nextUrl.pathname.startsWith('/api/')?null:businessContentPolicy(randomBytes(18).toString('base64'),process.env.NODE_ENV==='development');
    if(csp)upstream.set('content-security-policy',csp);
    const response = NextResponse.next({ request: { headers: upstream } });
    if(csp)response.headers.set('content-security-policy',csp);
    response.headers.set("cache-control", SECURITY_HEADERS["cache-control"]);
    return response;
  } catch (error) {
    const e = error instanceof SecurityError ? error : new SecurityError("SECURITY_UNAVAILABLE", 503);
    try {const {service}=await securityRuntime();await service.audit("BUSINESS_ACCESS_DENIED",{origin:service.origin,ip:trustedSourceIp(request.headers),userAgent:request.headers.get("user-agent")??"",target:request.nextUrl.pathname,method:request.method},e.code);}catch{/* Audit failures never allow access. */}
    const documentNavigation=request.headers.get("sec-fetch-dest")==="document" ||
      (!request.nextUrl.pathname.startsWith("/api/") && request.headers.get("accept")?.includes("text/html"));
    if (request.method === "GET" && documentNavigation && process.env.SECURITY_ORIGIN) {
      const url = securityReturnUrl(process.env.SECURITY_ORIGIN, request.nextUrl.pathname, request.nextUrl.search);
      const response = NextResponse.redirect(url); response.headers.set("cache-control", "no-store"); response.headers.set("referrer-policy", "no-referrer"); return response;
    }
    return NextResponse.json({ error: e.code }, { status: e.status, headers: SECURITY_HEADERS });
  }
}
