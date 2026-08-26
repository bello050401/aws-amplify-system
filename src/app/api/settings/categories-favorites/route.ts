import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/apiHelpers";
import {
  addFavoriteCategory,
  listFavoriteCategories,
  removeFavoriteCategory,
} from "@/domain/services/CategoryService";

export async function GET() {
  const favorites = await listFavoriteCategories();
  return NextResponse.json({ favorites });
}

export async function POST(req: NextRequest) {
  try {
    const { categoryMappingId } = await req.json();
    await addFavoriteCategory(categoryMappingId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { categoryMappingId } = await req.json();
    await removeFavoriteCategory(categoryMappingId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
