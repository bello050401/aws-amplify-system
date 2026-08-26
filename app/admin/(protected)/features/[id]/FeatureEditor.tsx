"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { FeatureWithItems } from "@/lib/features/queries";
import {
  archiveFeature,
  deleteFeature,
  publishFeature,
  regenerateWholeFeature,
  removeFeatureItem,
  unpublishFeature,
  updateFeature,
} from "@/app/actions/features";
import type { TemplateType } from "@/lib/ai";
import { Hero } from "@/components/features/Hero";
import { Introduction } from "@/components/features/Introduction";
import { ColorVariation } from "@/components/features/ColorVariation";
import { ProductGrid } from "@/components/features/ProductGrid";
import { Cta } from "@/components/features/Cta";

interface FeatureEditorProps {
  feature: FeatureWithItems;
}

const TEMPLATE_OPTIONS: TemplateType[] = ["COLLECTION", "BRAND", "FEATURE"];

export function FeatureEditor({ feature }: FeatureEditorProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState({
    title: feature.title,
    slug: feature.slug,
    templateType: feature.templateType,
    seoTitle: feature.seoTitle ?? "",
    seoDescription: feature.seoDescription ?? "",
    headline: feature.content?.headline ?? "",
    intro: feature.content?.intro ?? "",
    productGroupNotes: feature.content?.productGroupNotes ?? "",
    differenceNotes: feature.content?.differenceNotes ?? "",
    colorVariationNotes: feature.content?.colorVariationNotes ?? "",
    stylingSuggestion: feature.content?.stylingSuggestion ?? "",
    ctaText: feature.content?.ctaText ?? "",
  });

  function field<K extends Exclude<keyof typeof form, "templateType">>(key: K) {
    return {
      value: form[key],
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        setForm((prev) => ({ ...prev, [key]: e.target.value })),
    };
  }

  function save() {
    startTransition(async () => {
      await updateFeature(feature.id, {
        title: form.title,
        slug: form.slug,
        templateType: form.templateType,
        seoTitle: form.seoTitle,
        seoDescription: form.seoDescription,
        content: {
          headline: form.headline,
          intro: form.intro,
          productGroupNotes: form.productGroupNotes,
          differenceNotes: form.differenceNotes,
          colorVariationNotes: form.colorVariationNotes,
          stylingSuggestion: form.stylingSuggestion,
          ctaText: form.ctaText,
        },
      });
      router.refresh();
    });
  }

  function regenerateAll() {
    startTransition(async () => {
      await regenerateWholeFeature(feature.id);
      router.refresh();
    });
  }

  const heroItem =
    feature.items.find((i) => i.itemId === feature.heroBaseItemId) ?? feature.items[0];
  const brand = feature.items.find((i) => i.brand)?.brand;

  return (
    <div className="grid grid-cols-1 gap-10 lg:grid-cols-2">
      {/* --- Edit form --- */}
      <div>
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-normal text-ink">特集を編集</h1>
          <StatusBadge status={feature.status} />
        </div>

        <div className="mt-6 space-y-5">
          <LabeledInput label="特集タイトル" {...field("title")} />
          <LabeledInput label="URLスラッグ (/features/…)" {...field("slug")} />

          <div>
            <label className="block text-xs uppercase tracking-label text-muted">テンプレート</label>
            <select
              value={form.templateType}
              onChange={(e) => setForm((p) => ({ ...p, templateType: e.target.value as TemplateType }))}
              className="mt-1 w-full border border-line px-3 py-2 text-sm focus:border-ink focus:outline-none"
            >
              {TEMPLATE_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          <LabeledTextarea label="キャッチコピー" rows={2} {...field("headline")} />
          <LabeledTextarea label="導入文" rows={4} {...field("intro")} />
          <LabeledTextarea label="商品群の特徴" rows={3} {...field("productGroupNotes")} />
          <LabeledTextarea label="商品同士の違い" rows={3} {...field("differenceNotes")} />
          <LabeledTextarea label="カラー・仕様紹介" rows={2} {...field("colorVariationNotes")} />
          <LabeledTextarea label="コーディネート提案" rows={3} {...field("stylingSuggestion")} />
          <LabeledInput label="CTA文言" {...field("ctaText")} />
          <LabeledInput label="SEOタイトル" {...field("seoTitle")} />
          <LabeledTextarea label="meta description" rows={2} {...field("seoDescription")} />

          <div>
            <p className="text-xs uppercase tracking-label text-muted">掲載商品 ({feature.items.length})</p>
            <ul className="mt-2 divide-y divide-line border border-line">
              {feature.items.map((item, index) => {
                const row = feature.featureItemRows[index];
                return (
                  <li key={item.itemId} className="flex items-center justify-between px-3 py-2 text-sm">
                    <span className="truncate">{item.title}</span>
                    {row && (
                      <button
                        onClick={() =>
                          startTransition(async () => {
                            await removeFeatureItem(row.id, feature.id);
                            router.refresh();
                          })
                        }
                        className="ml-3 shrink-0 text-xs text-muted underline hover:text-red-600"
                      >
                        削除
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="mt-1 text-xs text-muted">商品の並び替えは Phase 2 で対応予定です。</p>
          </div>
        </div>

        <div className="mt-8 flex flex-wrap gap-3">
          <button
            onClick={save}
            disabled={pending}
            className="bg-ink px-5 py-2 text-xs uppercase tracking-label text-white disabled:opacity-50"
          >
            保存
          </button>
          <button
            onClick={regenerateAll}
            disabled={pending}
            className="border border-ink px-5 py-2 text-xs uppercase tracking-label text-ink disabled:opacity-50"
          >
            ページ全体を再生成
          </button>
          {feature.status === "PUBLISHED" ? (
            <button
              onClick={() => startTransition(async () => { await unpublishFeature(feature.id); router.refresh(); })}
              className="border border-line px-5 py-2 text-xs uppercase tracking-label text-muted hover:text-ink"
            >
              非公開にする
            </button>
          ) : (
            <button
              onClick={() => startTransition(async () => { await publishFeature(feature.id); router.refresh(); })}
              disabled={pending}
              className="border border-ink px-5 py-2 text-xs uppercase tracking-label text-ink disabled:opacity-50"
            >
              公開する
            </button>
          )}
          {feature.status !== "ARCHIVED" && (
            <button
              onClick={() => startTransition(async () => { await archiveFeature(feature.id); router.refresh(); })}
              className="border border-line px-5 py-2 text-xs uppercase tracking-label text-muted hover:text-ink"
            >
              アーカイブ
            </button>
          )}
          <button
            onClick={() => {
              if (confirm("この特集を完全に削除します。よろしいですか？")) {
                startTransition(async () => { await deleteFeature(feature.id); });
              }
            }}
            className="px-5 py-2 text-xs uppercase tracking-label text-red-600 underline"
          >
            削除
          </button>
        </div>

        {feature.status === "PUBLISHED" && (
          <p className="mt-4 text-xs text-muted">
            公開URL:{" "}
            <a href={`/features/${feature.slug}`} target="_blank" rel="noopener noreferrer" className="underline">
              /features/{feature.slug}
            </a>
          </p>
        )}
      </div>

      {/* --- Live preview (unsaved edits included) --- */}
      <div className="border border-line">
        <p className="border-b border-line bg-stone px-4 py-2 text-xs uppercase tracking-label text-muted">
          プレビュー
        </p>
        <div className="max-h-[85vh] overflow-y-auto">
          {heroItem?.images[0] && (
            <Hero brand={brand} title={form.title} headline={form.headline} imageUrl={heroItem.images[0].url} />
          )}
          <Introduction
            intro={form.intro}
            productGroupNotes={form.productGroupNotes}
            secondaryImageUrl={feature.items[1]?.images[0]?.url}
          />
          {form.templateType === "COLLECTION" && (
            <ColorVariation items={feature.items} notes={form.colorVariationNotes} />
          )}
          <ProductGrid items={feature.items} />
          <Cta text={form.ctaText || "BASEで見る"} href={feature.items[0]?.itemUrl ?? "#"} />
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const label = { DRAFT: "下書き", PUBLISHED: "公開中", ARCHIVED: "アーカイブ済み" }[status] ?? status;
  return <span className="border border-line px-3 py-1 text-xs uppercase tracking-label text-muted">{label}</span>;
}

function LabeledInput({
  label,
  ...props
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-label text-muted">{label}</label>
      <input
        {...props}
        className="mt-1 w-full border border-line px-3 py-2 text-sm focus:border-ink focus:outline-none"
      />
    </div>
  );
}

function LabeledTextarea({
  label,
  ...props
}: { label: string } & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-label text-muted">{label}</label>
      <textarea
        {...props}
        className="mt-1 w-full border border-line px-3 py-2 text-sm focus:border-ink focus:outline-none"
      />
    </div>
  );
}
