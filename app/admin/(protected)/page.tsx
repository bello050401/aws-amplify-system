import Link from "next/link";
import { listFeaturesForDashboard } from "@/lib/features/queries";

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "下書き",
  PUBLISHED: "公開",
  ARCHIVED: "アーカイブ",
};

export default async function AdminDashboardPage() {
  const features = await listFeaturesForDashboard();

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-normal text-ink">特集一覧</h1>
        <Link
          href="/admin/search"
          className="border border-ink px-5 py-2 text-xs uppercase tracking-label text-ink hover:bg-ink hover:text-white"
        >
          + 新しい特集を作る
        </Link>
      </div>

      {features.length === 0 ? (
        <p className="mt-16 text-sm text-muted">
          まだ特集がありません。「商品検索」から商品を選んで生成してください。
        </p>
      ) : (
        <table className="mt-8 w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line text-xs uppercase tracking-label text-muted">
              <th className="py-3 font-normal">特集</th>
              <th className="py-3 font-normal">状態</th>
              <th className="py-3 font-normal">テンプレート</th>
              <th className="py-3 font-normal">商品数</th>
              <th className="py-3 font-normal">作成日</th>
              <th className="py-3 font-normal" />
            </tr>
          </thead>
          <tbody>
            {features.map((f) => (
              <tr key={f.id} className="border-b border-line">
                <td className="py-4 pr-4">{f.title}</td>
                <td className="py-4 pr-4">{STATUS_LABEL[f.status]}</td>
                <td className="py-4 pr-4">{f.templateType}</td>
                <td className="py-4 pr-4">{f.itemCount}</td>
                <td className="py-4 pr-4 text-muted">{new Date(f.createdAt).toLocaleDateString("ja-JP")}</td>
                <td className="py-4 text-right">
                  <Link href={`/admin/features/${f.id}`} className="text-xs uppercase tracking-label text-ink underline">
                    編集
                  </Link>
                  {f.status === "PUBLISHED" && (
                    <>
                      {" / "}
                      <a
                        href={`/features/${f.slug}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs uppercase tracking-label text-ink underline"
                      >
                        表示
                      </a>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="mt-10 text-xs text-muted">
        売り切れ率・アーカイブ推奨バナー・商品並び替えは Phase 2 で追加予定です。
      </p>
    </div>
  );
}
