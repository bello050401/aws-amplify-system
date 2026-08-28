"use client";

import { Suspense, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { MobileHeader } from "@/components/layout/MobileHeader";
import { InventoryForm } from "@/components/inventory/InventoryForm";
import { DEFAULT_ITEM_FORM_VALUES, type ItemFormValues } from "@/lib/validation/itemSchema";
import { getInventoryService } from "@/lib/api";
import { useAuth } from "@/lib/auth/AuthProvider";
import { toErrorMessage } from "@/components/common/ErrorState";
import { todayDateOnlyJST } from "@/lib/utils/date";
import { LoadingOverlay } from "@/components/common/LoadingOverlay";

/** 新規登録画面(指示書 §16)。編集画面と共通のInventoryFormをcreateモードで使う。 */
export default function NewInventoryPage() {
  return (
    <Suspense fallback={<LoadingOverlay />}>
      <NewInventoryPageInner />
    </Suspense>
  );
}

function NewInventoryPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const draftItemId = useMemo(() => crypto.randomUUID(), []);
  const [thumbnailKey, setThumbnailKey] = useState<string | null>(null);
  const [imageKeys, setImageKeys] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initialValues: ItemFormValues = {
    ...DEFAULT_ITEM_FORM_VALUES,
    barcode: searchParams.get("barcode"),
    stocktakeDate: todayDateOnlyJST(),
  };

  async function handleSubmit(values: ItemFormValues) {
    setSubmitting(true);
    setError(null);
    try {
      const actor = user?.email ?? "unknown";
      const item = await getInventoryService().createItem(
        {
          ...values,
          freeQuantity: values.freeQuantity ?? values.quantity,
          thumbnailKey,
          imageKeys,
          userGroup: user?.groups[0] ?? null,
        },
        actor,
        draftItemId
      );
      router.replace(`/inventory/${item.id}`);
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <MobileHeader title="在庫の新規登録" />
      {error && <p className="px-4 pt-2 text-sm text-danger-600">{error}</p>}
      <InventoryForm
        draftItemId={draftItemId}
        initialValues={initialValues}
        thumbnailKey={thumbnailKey}
        imageKeys={imageKeys}
        onThumbnailChange={setThumbnailKey}
        onImagesChange={setImageKeys}
        onSubmit={handleSubmit}
        submitting={submitting}
        submitLabel="登録する"
      />
    </div>
  );
}
