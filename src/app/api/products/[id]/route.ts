import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/apiHelpers";
import { productFormSchema } from "@/domain/validation/productSchema";
import { deleteProduct, getProductDetail, updateProduct } from "@/domain/services/ProductService";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const product = await getProductDetail(id);
  if (!product) {
    return NextResponse.json({ error: "商品が見つかりません。" }, { status: 404 });
  }
  return NextResponse.json({ product });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const input = productFormSchema.parse(body);
    const product = await updateProduct(id, input);
    return NextResponse.json({ product });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await deleteProduct(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
