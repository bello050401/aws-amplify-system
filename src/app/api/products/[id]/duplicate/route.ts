import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/apiHelpers";
import { duplicateProduct } from "@/domain/services/ProductService";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const copyImages = Boolean(body?.copyImages);
    const product = await duplicateProduct(id, { copyImages });
    return NextResponse.json({ product }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
