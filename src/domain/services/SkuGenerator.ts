import { prisma } from "@/lib/prisma";

const PREFIX = "BELLO";
const DIGITS = 6;

/**
 * `BELLO-000001` 形式のSKUを自動採番する（指示書7項）。
 * 手入力SKUも許可するため、生成時は既存の最大採番済み番号+1を使う。
 */
export async function generateNextSku(): Promise<string> {
  const like = `${PREFIX}-%`;
  const rows = await prisma.product.findMany({
    where: { sku: { startsWith: `${PREFIX}-` } },
    select: { sku: true },
  });
  void like;

  let max = 0;
  for (const row of rows) {
    const match = row.sku.match(new RegExp(`^${PREFIX}-(\\d{${DIGITS}})$`));
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > max) max = n;
    }
  }
  const next = max + 1;
  return `${PREFIX}-${String(next).padStart(DIGITS, "0")}`;
}

export async function isSkuTaken(sku: string, excludeProductId?: string): Promise<boolean> {
  const existing = await prisma.product.findUnique({ where: { sku } });
  if (!existing) return false;
  if (excludeProductId && existing.id === excludeProductId) return false;
  return true;
}
