"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { MobileHeader } from "@/components/layout/MobileHeader";
import { LoadingOverlay } from "@/components/common/LoadingOverlay";
import { ErrorState, toErrorMessage } from "@/components/common/ErrorState";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { LocationPicker } from "@/components/common/LocationPicker";
import { NumberInput } from "@/components/common/NumberInput";
import { getInventoryService } from "@/lib/api";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useMasterData } from "@/lib/hooks/useMasterData";
import type { Item } from "@/lib/types";
import { formatDateOnlyForDisplay, formatDateTimeJST } from "@/lib/utils/date";
import { formatPrice, formatQuantity, displayOrDash } from "@/lib/utils/format";

/** 物品詳細画面(指示書 §7, §8)。 */
export default function InventoryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user, isAdmin } = useAuth();
  const { categories, locations } = useMasterData();

  const [item, setItem] = useState<Item | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState<{ key: string; url: string }[]>([]);
  const [activeImage, setActiveImage] = useState(0);

  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const category = categories.find((c) => c.id === item?.categoryId);
  const location = locations.find((l) => l.id === item?.locationId);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const service = getInventoryService();
      const found = await service.getItem(id);
      if (!found) {
        setError("在庫が見つかりませんでした");
        return;
      }
      setItem(found);
      const keys = [found.thumbnailKey, ...found.imageKeys].filter((k): k is string => !!k);
      const resolved = await Promise.all(keys.map(async (key) => ({ key, url: await service.getImageUrl(key) })));
      setImages(resolved);
      setActiveImage(0);
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function handleDelete() {
    if (!item) return;
    setBusy(true);
    try {
      await getInventoryService().deleteItem(item.id, user?.email ?? "unknown");
      router.replace("/inventory");
    } catch (e) {
      alert(toErrorMessage(e));
    } finally {
      setBusy(false);
      setDeleteOpen(false);
    }
  }

  async function handleDuplicate() {
    if (!item) return;
    setBusy(true);
    try {
      const copy = await getInventoryService().duplicateItem(item.id, user?.email ?? "unknown");
      router.push(`/inventory/${copy.id}`);
    } catch (e) {
      alert(toErrorMessage(e));
    } finally {
      setBusy(false);
      setMenuOpen(false);
    }
  }

  if (loading) return <LoadingOverlay />;
  if (error || !item) return <ErrorState message={error ?? "在庫が見つかりません"} onRetry={load} />;

  return (
    <div className="pb-32">
      <MobileHeader
        title="物品詳細"
        right={
          <button onClick={() => setMenuOpen(true)} className="tap-target text-xs font-semibold text-bello-700">
            MENU
          </button>
        }
      />

      <div className="space-y-4 px-4 py-4 md:px-0">
        <div className="flex flex-wrap gap-1">
          {item.status && (
            <span className="rounded-full bg-bello-100 px-2.5 py-1 text-xs font-medium text-bello-700">{item.status}</span>
          )}
          {category && (
            <span className="rounded-full bg-accent-100 px-2.5 py-1 text-xs font-medium text-accent-700">{category.name}</span>
          )}
        </div>
        <h1 className="text-lg font-bold text-bello-900">{item.name}</h1>

        <div className="overflow-hidden rounded-2xl bg-bello-50">
          <div className="flex aspect-square items-center justify-center">
            {images[activeImage] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={images[activeImage].url} alt={item.name} className="h-full w-full object-cover" />
            ) : (
              <span className="text-5xl text-bello-200">📦</span>
            )}
          </div>
          {images.length > 1 && (
            <div className="flex gap-2 overflow-x-auto p-2">
              {images.map((img, i) => (
                <button
                  key={img.key}
                  onClick={() => setActiveImage(i)}
                  className={`h-14 w-14 shrink-0 overflow-hidden rounded-lg border-2 ${
                    i === activeImage ? "border-bello-700" : "border-transparent"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.url} alt="" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2 rounded-2xl bg-white p-4 shadow-card text-center">
          <Stat label="数量" value={`${formatQuantity(item.quantity)}${item.unit}`} />
          <Stat label="フリー数" value={`${formatQuantity(item.freeQuantity)}${item.unit}`} />
          <Stat label="発注点" value={item.reorderPoint != null ? String(item.reorderPoint) : "-"} />
        </div>

        {location && (
          <div className="flex items-center gap-2 rounded-2xl bg-bello-50 px-4 py-3 text-base font-semibold text-bello-800">
            📍 {location.name}
          </div>
        )}

        <Link
          href={`/inventory/${item.id}/history`}
          className="tap-target flex w-full items-center justify-center rounded-2xl bg-bello-100 py-3.5 text-sm font-bold text-bello-800"
        >
          変更履歴を見る
        </Link>

        <section className="rounded-2xl bg-white p-4 shadow-card">
          <h2 className="mb-3 text-sm font-bold text-bello-800">詳細項目</h2>
          <dl className="divide-y divide-bello-50 text-sm">
            <Row label="在庫ID" value={item.id} />
            <Row label="物品名" value={item.name} />
            <Row label="カテゴリ" value={category?.name} />
            <Row label="状態" value={item.status} />
            <Row label="QRコード・バーコードの値" value={item.barcode} />
            <Row label="棚卸日" value={formatDateOnlyForDisplay(item.stocktakeDate)} />
            <Row label="☆販売予定価格(送料別記載)" value={formatPrice(item.plannedPrice)} />
            <Row label="1回目値下げ時の金額(30日)" value={formatPrice(item.discountPrice30)} />
            <Row label="2回目値下げ時の金額(60日)" value={formatPrice(item.discountPrice60)} />
            <Row label="3回目値下げ時の金額(90日)" value={formatPrice(item.discountPrice90)} />
            <Row label="コンディション評価" value={item.condition != null ? `${item.condition} / 5` : null} />
            <Row label="傷汚れ箇所等メモ" value={item.damageNotes} />
            <Row label="幅" value={item.widthCm != null ? `${item.widthCm} cm` : null} />
            <Row label="奥行" value={item.depthCm != null ? `${item.depthCm} cm` : null} />
            <Row label="高さ" value={item.heightCm != null ? `${item.heightCm} cm` : null} />
            <Row label="全長" value={item.lengthCm != null ? `${item.lengthCm} cm` : null} />
            <Row label="家財区分" value={item.householdCategory} />
            <Row label="品目" value={item.itemType} />
            <Row label="取引年月日" value={formatDateOnlyForDisplay(item.transactionDate)} />
            <Row label="古物の特徴" value={item.antiqueFeature} />
            <Row label="数量" value={`${formatQuantity(item.quantity)}${item.unit}`} />
            <Row label="更新日" value={formatDateTimeJST(item.updatedAt)} />
            <Row label="最終更新者" value={item.updatedBy} />
            <Row label="所属ユーザーグループ" value={item.userGroup} />
          </dl>
        </section>

        {item.notes && (
          <section className="rounded-2xl bg-white p-4 shadow-card">
            <h2 className="mb-2 text-sm font-bold text-bello-800">備考</h2>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-bello-700">{item.notes}</p>
          </section>
        )}
      </div>

      <Link
        href={`/inventory/${item.id}/edit`}
        className="tap-target fixed bottom-24 right-4 z-30 flex items-center gap-2 rounded-full bg-bello-800 px-5 py-3.5 text-sm font-bold text-white shadow-floating md:bottom-8"
      >
        ✎ 編集
      </Link>

      {menuOpen && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 md:items-center" onClick={() => setMenuOpen(false)}>
          <div
            className="w-full max-w-sm rounded-t-3xl bg-white p-2 pb-safe-nav shadow-floating md:rounded-3xl"
            onClick={(e) => e.stopPropagation()}
          >
            <MenuItem label="データの複製" onClick={handleDuplicate} disabled={busy} />
            <MenuItem
              label="数量移動"
              onClick={() => {
                setMenuOpen(false);
                setMoveOpen(true);
              }}
            />
            <MenuItem
              label="データを削除する"
              danger
              onClick={() => {
                setMenuOpen(false);
                setDeleteOpen(true);
              }}
              disabled={!isAdmin}
              hint={!isAdmin ? "削除にはAdmins権限が必要です" : undefined}
            />
            <button
              onClick={() => setMenuOpen(false)}
              className="tap-target mt-1 w-full rounded-2xl py-3 text-center text-sm font-semibold text-bello-400"
            >
              閉じる
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleteOpen}
        title="この在庫を削除しますか?"
        description="この操作は取り消せません(論理削除として記録されます)。"
        danger
        loading={busy}
        confirmLabel="削除する"
        onConfirm={handleDelete}
        onCancel={() => setDeleteOpen(false)}
      />

      {moveOpen && item && (
        <MoveQuantityDialog
          item={item}
          onClose={() => setMoveOpen(false)}
          onDone={() => {
            setMoveOpen(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-lg font-bold text-bello-900">{value}</p>
      <p className="text-xs text-bello-400">{label}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex justify-between gap-4 py-2.5">
      <dt className="shrink-0 text-bello-400">{label}</dt>
      <dd className="text-right text-bello-800">{displayOrDash(value)}</dd>
    </div>
  );
}

function MenuItem({
  label,
  onClick,
  danger,
  disabled,
  hint,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`tap-target flex w-full flex-col items-start rounded-2xl px-4 py-3.5 text-left text-sm font-semibold disabled:opacity-40 ${
        danger ? "text-danger-500" : "text-bello-800"
      }`}
    >
      {label}
      {hint && <span className="text-xs font-normal text-bello-400">{hint}</span>}
    </button>
  );
}

function MoveQuantityDialog({
  item,
  onClose,
  onDone,
}: {
  item: Item;
  onClose: () => void;
  onDone: () => void;
}) {
  const { user } = useAuth();
  const [toLocationId, setToLocationId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState<number | null>(item.quantity);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!toLocationId || !quantity) {
      setError("移動先と数量を入力してください");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await getInventoryService().moveStock(item.id, quantity, toLocationId, user?.email ?? "unknown");
      onDone();
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center">
      <div className="w-full max-w-sm space-y-4 rounded-t-3xl bg-white p-6 pb-safe-nav shadow-floating md:rounded-3xl">
        <h2 className="text-base font-bold text-bello-900">数量移動</h2>
        <LocationPicker label="移動先の保管場所" value={toLocationId} onChange={setToLocationId} />
        <NumberInput label="移動数量" value={quantity} onChange={setQuantity} suffix={item.unit} min={0} />
        {error && <p className="text-sm text-danger-600">{error}</p>}
        <div className="flex gap-3">
          <button onClick={onClose} className="tap-target flex-1 rounded-full border border-bello-200 py-3 text-sm font-semibold text-bello-700">
            キャンセル
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="tap-target flex-1 rounded-full bg-bello-800 py-3 text-sm font-bold text-white disabled:opacity-60"
          >
            {busy ? "処理中..." : "移動する"}
          </button>
        </div>
      </div>
    </div>
  );
}
