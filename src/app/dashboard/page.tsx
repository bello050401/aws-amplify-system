import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

function formatYen(n: number) {
  return `¥${n.toLocaleString("ja-JP")}`;
}

export default async function DashboardPage() {
  const [total, published, notListed, soldOut, apiErrors, priceAgg] = await Promise.all([
    prisma.product.count(),
    prisma.product.count({ where: { internalStatus: "PUBLISHED" } }),
    prisma.product.count({ where: { internalStatus: { in: ["DRAFT", "READY"] } } }),
    prisma.product.count({ where: { internalStatus: "SOLD_OUT" } }),
    prisma.product.count({ where: { internalStatus: "ERROR" } }),
    prisma.product.aggregate({ _sum: { price: true } }),
  ]);

  const cards = [
    { label: "総商品数", value: total },
    { label: "出品中", value: published },
    { label: "未出品", value: notListed },
    { label: "売却済み", value: soldOut },
    { label: "APIエラー", value: apiErrors, danger: apiErrors > 0 },
    { label: "在庫金額", value: formatYen(priceAgg._sum.price ?? 0) },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">ダッシュボード</h1>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {cards.map((c) => (
          <div key={c.label} className="card p-4">
            <div className="text-xs text-slate-500">{c.label}</div>
            <div
              className={`mt-1 text-2xl font-semibold ${c.danger ? "text-red-600" : "text-slate-900"}`}
            >
              {c.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
