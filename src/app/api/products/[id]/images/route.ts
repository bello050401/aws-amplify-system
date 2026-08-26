import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/apiHelpers";
import { addProductImage, reorderProductImages } from "@/domain/services/ImageService";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const form = await req.formData();
    const files = form.getAll("files").filter((f): f is File => f instanceof File);
    if (files.length === 0) {
      return NextResponse.json({ error: "ファイルが選択されていません。" }, { status: 400 });
    }
    for (const file of files) {
      await addProductImage({ productId: id, file });
    }
    const images = await prisma.productImage.findMany({
      where: { productId: id },
      orderBy: { sortOrder: "asc" },
    });
    return NextResponse.json({ images }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const orderedImageIds: string[] = body.orderedImageIds ?? [];
    await reorderProductImages(id, orderedImageIds);
    const images = await prisma.productImage.findMany({
      where: { productId: id },
      orderBy: { sortOrder: "asc" },
    });
    return NextResponse.json({ images });
  } catch (err) {
    return errorResponse(err);
  }
}
