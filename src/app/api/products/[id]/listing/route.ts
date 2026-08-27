import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/apiHelpers";
import { createMercariListing } from "@/domain/services/ListingService";

/** 「メルカリShopsへ出品」ボタンの送信先（指示書35項）。 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await createMercariListing(id);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return errorResponse(err, 502);
  }
}
