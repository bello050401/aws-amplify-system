"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PRODUCT_CONDITIONS } from "@/integrations/mercari-shops/mapper/condition";
import { SHIPPING_PAYERS } from "@/integrations/mercari-shops/mapper/shippingPayer";
import { SHIPPING_DURATIONS } from "@/integrations/mercari-shops/mapper/shippingDuration";
import { MERCARI_LIMITS } from "@/integrations/mercari-shops/types/limits";
import { PREFECTURES } from "@/lib/constants/prefectures";
import { CategoryPicker } from "./CategoryPicker";
import { BrandPicker } from "./BrandPicker";
import { ShippingTemplateSelect } from "./ShippingTemplateSelect";
import { DescriptionTemplateSelect } from "./DescriptionTemplateSelect";
import { ImageUploader, type ProductImageRow } from "./ImageUploader";

export interface ProductFormInitial {
  id?: string;
  sku: string;
  name: string;
  description: string;
  price: number;
  condition: string;
  categoryMappingId: string | null;
  categoryPath?: string | null;
  brandMappingId: string | null;
  brandName?: string | null;
  janCode: string | null;
  catalogId: string | null;
  shippingPayer: string;
  shippingFromStateId: string | null;
  shippingDurationCode: string | null;
  shippingTemplateId: string | null;
  stockQuantity: number;
  images?: ProductImageRow[];
}

export function ProductForm({ mode, initial }: { mode: "create" | "edit"; initial: ProductFormInitial }) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string | null>(null);

  function set<K extends keyof ProductFormInitial>(key: K, value: ProductFormInitial[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setErrors({});
    setFormError(null);
    try {
      const payload = {
        sku: values.sku,
        name: values.name,
        description: values.description,
        price: values.price,
        condition: values.condition,
        categoryMappingId: values.categoryMappingId,
        brandMappingId: values.brandMappingId,
        janCode: values.janCode || null,
        catalogId: values.catalogId || null,
        shippingPayer: values.shippingPayer,
        shippingFromStateId: values.shippingFromStateId,
        shippingDurationCode: values.shippingDurationCode,
        shippingTemplateId: values.shippingTemplateId,
        stockQuantity: values.stockQuantity,
      };

      const res = await fetch(mode === "create" ? "/api/products" : `/api/products/${initial.id}`, {
        method: mode === "create" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) {
        if (json.details?.fieldErrors) setErrors(json.details.fieldErrors);
        setFormError(json.error ?? "保存に失敗しました。");
        return;
      }
      if (mode === "create") {
        router.push(`/products/${json.product.id}`);
      } else {
        router.refresh();
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "通信エラーが発生しました。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div className="space-y-6">
        <Section title="基本情報">
          <Field label="SKU" error={errors.sku}>
            <input
              className="input font-mono"
              value={values.sku}
              onChange={(e) => set("sku", e.target.value)}
              required
            />
          </Field>

          <Field label="商品名" error={errors.name} hint={`現在 ${values.name.length}文字 / 最大 ${MERCARI_LIMITS.NAME_MAX}文字`}>
            <input
              className="input"
              value={values.name}
              maxLength={MERCARI_LIMITS.NAME_MAX}
              onChange={(e) => set("name", e.target.value)}
              required
            />
          </Field>

          <Field label="価格（円）" error={errors.price}>
            <input
              type="number"
              className="input"
              value={values.price || ""}
              min={1}
              step={1}
              onChange={(e) => set("price", Math.trunc(Number(e.target.value)))}
              required
            />
          </Field>

          <Field
            label="商品説明"
            error={errors.description}
            hint={`現在 ${values.description.length}文字 / 最大 ${MERCARI_LIMITS.DESCRIPTION_MAX}文字`}
          >
            <DescriptionTemplateSelect onApply={(body) => set("description", body)} />
            <textarea
              className="input mt-2 h-40"
              value={values.description}
              maxLength={MERCARI_LIMITS.DESCRIPTION_MAX}
              onChange={(e) => set("description", e.target.value)}
              required
            />
          </Field>
        </Section>

        <Section title="画像">
          {mode === "edit" && initial.id ? (
            <ImageUploader productId={initial.id} initialImages={values.images ?? []} />
          ) : (
            <p className="text-sm text-slate-500">
              商品を保存すると画像をアップロードできるようになります。まず基本情報を保存してください。
            </p>
          )}
        </Section>

        <Section title="商品状態">
          <Field label="商品状態" error={errors.condition}>
            <select
              className="input"
              value={values.condition}
              onChange={(e) => set("condition", e.target.value)}
            >
              {PRODUCT_CONDITIONS.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="JANコード（任意）">
            <input
              className="input"
              value={values.janCode ?? ""}
              onChange={(e) => set("janCode", e.target.value)}
            />
          </Field>
          <Field label="Catalog ID（任意）">
            <input
              className="input"
              value={values.catalogId ?? ""}
              onChange={(e) => set("catalogId", e.target.value)}
            />
          </Field>
        </Section>

        <Section title="在庫">
          <Field label="在庫数">
            <input
              type="number"
              className="input"
              min={0}
              value={values.stockQuantity}
              onChange={(e) => set("stockQuantity", Math.trunc(Number(e.target.value)))}
            />
          </Field>
          <p className="text-xs text-slate-400">リユース家具は基本的に1点物のため、在庫数は1を初期値としています。</p>
        </Section>
      </div>

      <div className="space-y-6">
        <Section title="配送">
          <Field label="配送料負担">
            <select
              className="input"
              value={values.shippingPayer}
              onChange={(e) => set("shippingPayer", e.target.value)}
            >
              {SHIPPING_PAYERS.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="配送元地域">
            <select
              className="input"
              value={values.shippingFromStateId ?? ""}
              onChange={(e) => set("shippingFromStateId", e.target.value || null)}
            >
              <option value="">選択してください</option>
              {PREFECTURES.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="発送までの日数">
            <select
              className="input"
              value={values.shippingDurationCode ?? ""}
              onChange={(e) => set("shippingDurationCode", e.target.value || null)}
            >
              <option value="">選択してください</option>
              {SHIPPING_DURATIONS.map((d) => (
                <option key={d.code} value={d.code}>
                  {d.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="配送テンプレート">
            <ShippingTemplateSelect
              value={values.shippingTemplateId}
              onChange={(id) => set("shippingTemplateId", id)}
            />
          </Field>
        </Section>

        <Section title="メルカリShops設定">
          <Field label="カテゴリー" error={errors.categoryMappingId}>
            <CategoryPicker
              value={values.categoryMappingId}
              onChange={(id) => set("categoryMappingId", id)}
            />
          </Field>
          <Field label="ブランド（任意）">
            <BrandPicker
              value={values.brandMappingId}
              valueName={values.brandName}
              onChange={(id, name) => {
                set("brandMappingId", id);
                set("brandName", name);
              }}
            />
          </Field>
        </Section>

        {formError && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {formError}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </form>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card space-y-4 p-5">
      <h2 className="section-title">{title}</h2>
      {children}
    </div>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string[];
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <label className="label mb-0">{label}</label>
        {hint && <span className="text-xs text-slate-400">{hint}</span>}
      </div>
      {children}
      {error && error.length > 0 && <p className="mt-1 text-xs text-red-600">{error[0]}</p>}
    </div>
  );
}
