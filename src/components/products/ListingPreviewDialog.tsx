"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatYen } from "@/lib/format";

export interface ListingPreviewSummary {
  name: string;
  price: number;
  conditionLabel: string;
  categoryPath: string | null;
  brandName: string | null;
  shippingPayerLabel: string;
  shippingDurationLabel: string | null;
  imageCount: number;
}

/** 出品前プレビューダイアログ（指示書54項）。 */
export function ListingPreviewDialog({
  productId,
  summary,
}: {
  productId: string;
  summary: ListingPreviewSummary;
}) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const router = useRouter();

  const canSubmit = summary.categoryPath && summary.imageCount > 0;

  async function submit() {
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch(`/api/products/${productId}/listing`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        setResult({ ok: false, message: json.error ?? "出品に失敗しました。" });
        return;
      }
      setResult({
        ok: true,
        message: `メルカリShops：出品成功（Mercari Product ID: ${json.result.externalProductId}）`,
      });
      router.refresh();
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : "通信エラー" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
        メルカリShopsへ出品
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
            <h2 className="section-title mb-3">出品内容の確認</h2>
            <dl className="space-y-1.5 text-sm">
              <Row label="商品名" value={summary.name} />
              <Row label="価格" value={formatYen(summary.price)} />
              <Row label="商品状態" value={summary.conditionLabel} />
              <Row label="カテゴリー" value={summary.categoryPath ?? "未設定"} warn={!summary.categoryPath} />
              <Row label="ブランド" value={summary.brandName ?? "指定なし"} />
              <Row label="送料負担" value={summary.shippingPayerLabel} />
              <Row label="発送までの日数" value={summary.shippingDurationLabel ?? "未設定"} />
              <Row
                label="画像枚数"
                value={`${summary.imageCount}枚`}
                warn={summary.imageCount === 0}
              />
            </dl>

            {!canSubmit && (
              <p className="mt-3 text-xs text-red-600">
                カテゴリーと画像は出品に必須です。商品編集画面で設定してください。
              </p>
            )}

            {result && (
              <p className={`mt-3 text-sm ${result.ok ? "text-green-700" : "text-red-600"}`}>
                {result.message}
              </p>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
                閉じる
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={!canSubmit || submitting}
                onClick={submit}
              >
                {submitting ? "送信中…" : "この内容でメルカリShopsへ出品する"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-slate-500">{label}</dt>
      <dd className={warn ? "font-medium text-red-600" : "font-medium text-slate-900"}>{value}</dd>
    </div>
  );
}
