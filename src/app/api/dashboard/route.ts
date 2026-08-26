import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/** ダッシュボード集計（指示書51項）。 */
export async function GET() {
  const [total, published, notListed, soldOut, errorCount, priceAgg] = await Promise.all([
    prisma.product.count(),
    prisma.product.count({ where: { internalStatus: "PUBLISHED" } }),
    prisma.product.count({ where: { internalStatus: { in: ["DRAFT", "READY"] } } }),
    prisma.product.count({ where: { internalStatus: "SOLD_OUT" } }),
    prisma.product.count({ where: { internalStatus: "ERROR" } }),
    prisma.product.aggregate({ _sum: { price: true } }),
  ]);

  return NextResponse.json({
    totalProducts: total,
    published,
    notListed,
    soldOut,
    apiErrors: errorCount,
    inventoryValue: priceAgg._sum.price ?? 0,
  });
}
