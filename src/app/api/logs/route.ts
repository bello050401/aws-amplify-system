import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const logs = await prisma.integrationLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { product: { select: { sku: true, name: true } } },
  });
  return NextResponse.json({ logs });
}
