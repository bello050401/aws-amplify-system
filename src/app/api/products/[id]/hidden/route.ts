import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/apiHelpers";
import { setProductHidden } from "@/domain/services/ProductService";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    await setProductHidden(id, Boolean(body.hidden));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
