import { NextResponse } from "next/server";
import outputs from "@/amplify_outputs.json";

export const dynamic = "force-dynamic";

/** Public Cognito identifiers only. Credentials and marketplace tokens stay server-side. */
export function GET() {
  return NextResponse.json({
    auth: {
      userPoolId: outputs.auth.user_pool_id,
      userPoolClientId: outputs.auth.user_pool_client_id,
    },
    contractVersion: 1,
    deviceSecurity: process.env.BELLO_DEVICE_SECURITY === "enforced",
    writesEnabled: process.env.BELLO_MOBILE_WRITES_ENABLED === "true",
  }, { headers: { "Cache-Control": "no-store" } });
}
