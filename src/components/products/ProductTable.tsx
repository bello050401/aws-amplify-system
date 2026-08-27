"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ProductConditionCode, ProductInternalStatus } from "@prisma/client";
import { ProductStatusBadge } from "./ProductStatusBadge";
import { formatDateTime, formatYen } from "@/lib/format";
import { conditionLabel } from "@/integrations/mercari-shops/mapper/condition";

export interface ProductRow {
  id: string;
  sku: string;
  name: string;
  price: number;
  condition: ProductConditionCode;
  internalStatus: ProductInternalStatus;
  createdAt: string;
  updatedAt: string;
  images: { publicUrl: string }[];
  mercariListing: { mercariProductId: string | null; mercariStatus: string | null } | null;
  variants?: { stockQuantity: number }[];
}

export function ProductTable({ products }: { products: ProductRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) => (prev.size === products.length ? new Set() : new Set(products.map((p) => p.id))));
  };

  async function runAction(id: string, action: () => Promise<Response>) {
    setBusyId(id);
    try {
      const res = await runAndParse(action);
      if (!res.ok) {
        alert(res.error ?? "操作に失敗しました。");
      }
      startTransition(() => router.refresh());
    } finally {
      setBusyId(null);
    }
  }

  async function handleListing(id: string) {
    await runAction(id, () => fetch(`/api/products/${id}/listing`, { method: "POST" }));
  }

  async function handleHide(id: string, hidden: boolean) {
    await runAction(id, () =>
      fetch(`/api/products/${id}/hidden`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden }),
      }),
    );
  }

  async function handleDuplicate(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/products/${id}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ copyImages: confirm("画像も複製しますか？") }),
      });
      const json = await res.json();
      if (!res.ok) {
        alert(json.error ?? "複製に失敗しました。");
        return;
      }
      router.push(`/products/${json.product.id}`);
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("この商品を削除します。よろしいですか？")) return;
    await runAction(id, () => fetch(`/api/products/${id}`, { method: "DELETE" }));
  }

  async function handleBulkHide(hidden: boolean) {
    if (selected.size === 0) return;
    if (!confirm(`選択した${selected.size}件を${hidden ? "非公開" : "出品可能"}にします。`)) return;
    for (const id of selected) {
      await fetch(`/api/products/${id}/hidden`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden }),
      });
    }
    setSelected(new Set());
    startTransition(() => router.refresh());
  }

  return (
    <div className="space-y-3">
      {selected.size > 0 && (
        <div className="card flex items-center gap-3 p-3 text-sm">
          <span>{selected.size}件選択中</span>
          <button className="btn-secondary" onClick={() => handleBulkHide(true)}>
            選択を非公開にする
          </button>
          <button className="btn-secondary" onClick={() => handleBulkHide(false)}>
            選択を出品可能にする
          </button>
          <span className="text-slate-400">一括出品は Phase 2 で対応予定です</span>
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="p-3">
                <input
                  type="checkbox"
                  checked={selected.size === products.length && products.length > 0}
                  onChange={toggleAll}
                />
              </th>
              <th className="p-3">画像</th>
              <th className="p-3">SKU</th>
              <th className="p-3">商品名</th>
              <th className="p-3">価格</th>
              <th className="p-3">在庫</th>
              <th className="p-3">商品状態</th>
              <th className="p-3">Mercari出品状態</th>
              <th className="p-3">Mercari商品ID</th>
              <th className="p-3">登録日</th>
              <th className="p-3">更新日</th>
              <th className="p-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id} className="border-t border-slate-100 align-top">
                <td className="p-3">
                  <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                </td>
                <td className="p-3">
                  {p.images[0] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.images[0].publicUrl}
                      alt={p.name}
                      className="h-14 w-14 rounded object-cover"
                    />
                  ) : (
                    <div className="flex h-14 w-14 items-center justify-center rounded bg-slate-100 text-[10px] text-slate-400">
                      画像なし
                    </div>
                  )}
                </td>
                <td className="p-3 font-mono text-xs">{p.sku}</td>
                <td className="p-3">
                  <Link href={`/products/${p.id}`} className="font-medium text-indigo-700 hover:underline">
                    {p.name}
                  </Link>
                </td>
                <td className="p-3">{formatYen(p.price)}</td>
                <td className="p-3">{p.variants?.[0]?.stockQuantity ?? "-"}</td>
                <td className="p-3">{conditionLabel(p.condition)}</td>
                <td className="p-3">
                  <ProductStatusBadge status={p.internalStatus} />
                </td>
                <td className="p-3 font-mono text-xs">{p.mercariListing?.mercariProductId ?? "-"}</td>
                <td className="p-3 whitespace-nowrap text-xs text-slate-500">{formatDateTime(p.createdAt)}</td>
                <td className="p-3 whitespace-nowrap text-xs text-slate-500">{formatDateTime(p.updatedAt)}</td>
                <td className="p-3">
                  <div className="flex flex-wrap gap-1.5">
                    <Link href={`/products/${p.id}`} className="btn-secondary">
                      編集
                    </Link>
                    <button
                      className="btn-secondary"
                      disabled={busyId === p.id}
                      onClick={() => handleDuplicate(p.id)}
                    >
                      複製
                    </button>
                    <button
                      className="btn-primary"
                      disabled={busyId === p.id || isPending}
                      onClick={() => handleListing(p.id)}
                    >
                      メルカリShopsへ出品
                    </button>
                    {p.internalStatus === "HIDDEN" ? (
                      <button className="btn-secondary" disabled={busyId === p.id} onClick={() => handleHide(p.id, false)}>
                        公開に戻す
                      </button>
                    ) : (
                      <button className="btn-secondary" disabled={busyId === p.id} onClick={() => handleHide(p.id, true)}>
                        非公開
                      </button>
                    )}
                    <button className="btn-danger" disabled={busyId === p.id} onClick={() => handleDelete(p.id)}>
                      削除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {products.length === 0 && (
              <tr>
                <td colSpan={12} className="p-8 text-center text-slate-400">
                  商品がまだ登録されていません。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

async function runAndParse(action: () => Promise<Response>): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await action();
    if (res.ok) return { ok: true };
    const json = await res.json().catch(() => ({}));
    return { ok: false, error: json.error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "通信エラー" };
  }
}
