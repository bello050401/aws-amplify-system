import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/apiHelpers";
import { z } from "zod";
import { createShippingTemplate, listShippingTemplates } from "@/domain/services/ShippingService";

const schema = z.object({
  name: z.string().trim().min(1),
  type: z.enum(["KAZAIBIN", "TAKKYUBIN", "FREE_SHIPPING", "PICKUP", "OTHER"]),
  mercariShippingConfigurationId: z.string().trim().optional().nullable(),
  isDefault: z.boolean().optional(),
  rates: z.array(z.object({ destination: z.string().min(1), fee: z.number().int().min(0) })).optional(),
});

export async function GET() {
  const templates = await listShippingTemplates();
  return NextResponse.json({ templates });
}

export async function POST(req: NextRequest) {
  try {
    const input = schema.parse(await req.json());
    const template = await createShippingTemplate(input);
    return NextResponse.json({ template }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
