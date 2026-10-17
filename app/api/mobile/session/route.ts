import { NextResponse } from "next/server";
import { getMobileSession } from "@/lib/mobile/session";

export const dynamic = "force-dynamic";
export async function GET() {
  const session = await getMobileSession();
  const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
  if (!session.ok) return NextResponse.json({ error: session.error }, { status: session.status, headers });
  return NextResponse.json({ owner: session.owner, role: session.role, features: session.features }, { headers });
}
