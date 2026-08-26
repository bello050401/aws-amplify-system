import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/apiHelpers";
import { productFormSchema } from "@/domain/validation/productSchema";
import { createProduct, listProducts } from "@/domain/services/ProductService";

export async function GET() {
  const products = await listProducts();
  return NextResponse.json({ products });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const input = productFormSchema.parse(body);
    const product = await createProduct(input);
    return NextResponse.json({ product }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
