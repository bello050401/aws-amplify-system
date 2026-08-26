import type { BaseItem } from "@/lib/base";
import type { Schema } from "@/amplify/data/resource";

export type TemplateType = Schema["TemplateType"]["type"];

export interface FeatureGenerationInput {
  items: BaseItem[];
  /** Human override — if omitted, a heuristic (see templateHeuristic.ts) picks one. */
  templateType?: TemplateType;
}

/**
 * Everything the AI is allowed to produce. Every field here is *copy* —
 * marketing language derived from the given items — never a fact about
 * an item (price/stock/size/material/…) that isn't already present
 * verbatim in the BaseItem data handed to it. See lib/ai/prompt.ts for
 * the guardrail this is built on.
 */
export interface FeatureCopy {
  title: string;
  slug: string;
  headline: string; // キャッチコピー
  intro: string; // 導入文
  productGroupNotes: string; // 商品群の特徴
  differenceNotes: string; // 商品同士の違い
  colorVariationNotes?: string; // カラー・仕様紹介（色違いがある場合のみ）
  stylingSuggestion: string; // コーディネート提案
  ctaText: string;
  seoTitle: string;
  seoDescription: string;
}

export type FeatureCopySection = keyof FeatureCopy;

export interface AIProvider {
  generateFeatureCopy(input: FeatureGenerationInput): Promise<FeatureCopy>;
  regenerateSection(
    input: FeatureGenerationInput,
    section: FeatureCopySection,
    current: FeatureCopy,
  ): Promise<string>;
}
