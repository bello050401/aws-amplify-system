import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/apiHelpers";
import { createShippingConfigurationForTemplate } from "@/domain/services/ShippingService";

/** Mercari Shops側にShippingConfigurationを作成し、テンプレートへ紐付ける（指示書27, 29項）。 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const configurationId = await createShippingConfigurationForTemplate(id);
    return NextResponse.json({ ok: true, configurationId });
  } catch (err) {
    return errorResponse(err, 502);
  }
}
