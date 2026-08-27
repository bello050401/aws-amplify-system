import { prisma } from "@/lib/prisma";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function LogsPage() {
  const logs = await prisma.integrationLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { product: { select: { sku: true, name: true } } },
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">APIログ</h1>
      <div className="card overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="p-3">日時</th>
              <th className="p-3">商品</th>
              <th className="p-3">操作</th>
              <th className="p-3">レベル</th>
              <th className="p-3">メッセージ</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id} className="border-t border-slate-100 align-top">
                <td className="whitespace-nowrap p-3 text-xs text-slate-500">
                  {formatDateTime(log.createdAt)}
                </td>
                <td className="p-3 text-xs">
                  {log.product ? `${log.product.sku} ${log.product.name}` : "-"}
                </td>
                <td className="p-3 font-mono text-xs">{log.operation}</td>
                <td className="p-3">
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs ${
                      log.level === "ERROR" ? "bg-red-50 text-red-700" : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {log.level}
                  </span>
                </td>
                <td className="p-3 text-xs">
                  {log.message}
                  {log.errorMessage && <div className="mt-0.5 text-red-600">{log.errorMessage}</div>}
                  {log.requestId && (
                    <div className="mt-0.5 text-slate-400">requestId: {log.requestId}</div>
                  )}
                </td>
              </tr>
            ))}
            {logs.length === 0 && (
              <tr>
                <td colSpan={5} className="p-8 text-center text-slate-400">
                  ログはまだありません。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
