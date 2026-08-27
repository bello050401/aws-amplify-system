import { NextResponse } from "next/server";
import { getShippingMethods } from "@/domain/services/ShippingService";

/** 配送方法の選択肢（指示書26項）。APIから動的取得し、失敗時のみフォールバックを返す。 */
export async function GET() {
  const methods = await getShippingMethods();
  return NextResponse.json({ methods });
}
