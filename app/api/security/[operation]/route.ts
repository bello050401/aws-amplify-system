import { NextRequest, NextResponse } from "next/server";
import { deviceSecurityEnabled, securityRuntime } from "@/lib/security/serverRuntime";
import { securityHttp, SECURITY_HEADERS } from "@/lib/security/http";
import {trustedSourceIp} from '@/lib/security/sourceIp';
export const dynamic = "force-dynamic";
export async function POST(request: NextRequest) {
  if (!deviceSecurityEnabled()) return NextResponse.json({ error: "NOT_ENABLED" }, { status: 404, headers: SECURITY_HEADERS });
  try {
    if (Number(request.headers.get("content-length") || 0) > 49152) return NextResponse.json({ error: "REQUEST_TOO_LARGE" }, { status: 413 });
    const runtime = await securityRuntime();
    const result = await securityHttp(runtime.service, { method: request.method, path: request.nextUrl.pathname,
      headers: Object.fromEntries(request.headers), body: await request.text(), ip: trustedSourceIp(request.headers) });
    const response = new NextResponse(result.body, { status: result.statusCode, headers: result.headers });
    result.cookies?.forEach(cookie => response.headers.append("set-cookie", cookie));
    return response;
  } catch { return NextResponse.json({ error: "SECURITY_UNAVAILABLE" }, { status: 503, headers: SECURITY_HEADERS }); }
}
