import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/apiHelpers";
import { z } from "zod";
import {
  getDefaultCondition,
  getDefaultShippingFromStateId,
  setDefaultCondition,
  setDefaultShippingFromStateId,
} from "@/domain/services/AppSettingsService";

const schema = z.object({
  condition: z
    .enum(["NEW", "LIKE_NEW", "NO_NOTABLE_DAMAGE", "SLIGHT_DAMAGE", "DAMAGE", "BAD"])
    .optional(),
  shippingFromStateId: z.string().trim().min(1).optional(),
});

export async function GET() {
  const [condition, shippingFromStateId] = await Promise.all([
    getDefaultCondition(),
    getDefaultShippingFromStateId(),
  ]);
  return NextResponse.json({ condition, shippingFromStateId });
}

export async function POST(req: NextRequest) {
  try {
    const input = schema.parse(await req.json());
    if (input.condition) await setDefaultCondition(input.condition);
    if (input.shippingFromStateId) await setDefaultShippingFromStateId(input.shippingFromStateId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
