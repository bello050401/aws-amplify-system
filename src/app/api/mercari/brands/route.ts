import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/apiHelpers";
import { searchBrands } from "@/domain/services/BrandService";

export async function GET(req: NextRequest) {
  try {
    const q = req.nextUrl.searchParams.get("q") ?? "";
    const brands = await searchBrands(q);
    return NextResponse.json({ brands });
  } catch (err) {
    return errorResponse(err, 502);
  }
}
