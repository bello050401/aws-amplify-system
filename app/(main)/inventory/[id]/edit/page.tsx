"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { MobileHeader } from "@/components/layout/MobileHeader";
import { InventoryForm } from "@/components/inventory/InventoryForm";
import { LoadingOverlay } from "@/components/common/LoadingOverlay";
import { ErrorState, toErrorMessage } from "@/components/common/ErrorState";
import { getInventoryService, OptimisticLockError } from "@/lib/api";
import { useAuth } from "@/lib/auth/AuthProvider";
import type { Item } from "@/lib/types";
import type { ItemFormValues } from "@/lib/validation/itemSchema";

/** 在庫編集画面(指示書 §9)。新規登録画面と共通のInventoryFormをeditモードで使う。 */
export default function EditInventoryPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const [item, setItem] = useState<Item | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [thumbnailKey, setThumbnailKey] = useState<string | null>(null);
  const [imageKeys, setImageKeys] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    getInventoryService()
      .getItem(id)
      .then((found) => {
        if (!active) return;
        if (!found) {
          setLoadError("在庫が見つかりませんでした");
        } else {
          setItem(found);
          setThumbnailKey(found.thumbnailKey ?? null);
          setImageKeys(found.imageKeys);
        }
      })
      .catch((e) => active && setLoadError(toErrorMessage(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [id]);

  async function handleSubmit(values: ItemFormValues) {
    if (!item) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const actor = user?.email ?? "unknown";
      await getInventoryService().updateItem(
        item.id,
        { ...values, freeQuantity: values.freeQuantity ?? item.freeQuantity, thumbnailKey, imageKeys },
        item.version,
        actor
      );
      router.replace(`/inventory/${item.id}`);
    } catch (e) {
      if (e instanceof OptimisticLockError) {
        setSubmitError(e.message);
      } else {
        setSubmitError(toErrorMessage(e));
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <LoadingOverlay />;
  if (loadError || !item) return <ErrorState message={loadError ?? "在庫が見つかりません"} />;

  const initialValues: ItemFormValues = {
    name: item.name,
    quantity: item.quantity,
    unit: item.unit,
    categoryId: item.categoryId ?? null,
    locationId: item.locationId ?? null,
    status: item.status ?? null,
    notes: item.notes ?? null,
    barcode: item.barcode ?? null,
    plannedPrice: item.plannedPrice ?? null,
    discountPrice30: item.discountPrice30 ?? null,
    discountPrice60: item.discountPrice60 ?? null,
    discountPrice90: item.discountPrice90 ?? null,
    condition: item.condition ?? null,
    damageNotes: item.damageNotes ?? null,
    widthCm: item.widthCm ?? null,
    depthCm: item.depthCm ?? null,
    heightCm: item.heightCm ?? null,
    lengthCm: item.lengthCm ?? null,
    householdCategory: item.householdCategory ?? null,
    itemType: item.itemType ?? null,
    transactionDate: item.transactionDate ?? null,
    antiqueFeature: item.antiqueFeature ?? null,
    stocktakeDate: item.stocktakeDate ?? null,
    freeQuantity: item.freeQuantity,
    reorderPoint: item.reorderPoint ?? null,
  };

  return (
    <div>
      <MobileHeader title="在庫の編集をする" />
      {submitError && <p className="px-4 pt-2 text-sm text-danger-600">{submitError}</p>}
      <InventoryForm
        draftItemId={item.id}
        initialValues={initialValues}
        thumbnailKey={thumbnailKey}
        imageKeys={imageKeys}
        onThumbnailChange={setThumbnailKey}
        onImagesChange={setImageKeys}
        onSubmit={handleSubmit}
        submitting={submitting}
        submitLabel="完了"
      />
    </div>
  );
}
