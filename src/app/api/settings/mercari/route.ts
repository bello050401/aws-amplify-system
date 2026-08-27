import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/apiHelpers";
import { z } from "zod";
import { hasMercariAccessToken, saveMercariAccessToken } from "@/domain/services/MercariSettingsService";
import { getMercariEnvironment } from "@/integrations/mercari-shops/endpoints";

const tokenSchema = z.object({ token: z.string().trim().min(10, "トークンが短すぎます。") });

export async function GET() {
  const environment = getMercariEnvironment();
  const configured = await hasMercariAccessToken(environment);
  return NextResponse.json({ environment, configured });
}

/** Personal API Access Token を暗号化して保存する（指示書32項）。トークンをログに出さない。 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { token } = tokenSchema.parse(body);
    await saveMercariAccessToken(token);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
