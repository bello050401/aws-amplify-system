import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/apiHelpers";
import { deleteShippingTemplate } from "@/domain/services/ShippingService";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await deleteShippingTemplate(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
