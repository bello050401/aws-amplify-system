/**
 * 取得済みのBASE過去商品から BELLO Style Profile を作る。
 *
 * Run with: node scripts/with-server-only-stub.cjs scripts/build-style-profile.ts <items.json> <out.json>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { buildStyleProfile, type StyleProfileSourceItem } from "@/lib/ai/productIntro/styleProfile";

interface RawItem { item_id: number | string; title: string; detail: string; modified?: number; price?: number }
const raw = JSON.parse(readFileSync(process.argv[2], "utf8")) as { items: RawItem[] };

const source: StyleProfileSourceItem[] = raw.items.map((it) => ({
  baseItemId: String(it.item_id),
  title: it.title ?? "",
  description: it.detail ?? "",
  // BASEの modified はunix秒。
  modifiedAt: it.modified ? new Date(it.modified * 1000).toISOString() : null,
  price: typeof it.price === "number" ? it.price : null,
}));

const profile = buildStyleProfile(source);
writeFileSync(process.argv[3], JSON.stringify(profile, null, 1));

console.log(JSON.stringify({
  analyzedItemCount: profile.analyzedItemCount,
  introExtractedCount: profile.introExtractedCount,
  analysisPeriod: profile.analysisPeriod,
  confidence: profile.confidence,
  recommendedSectionOrder: profile.recommendedSectionOrder,
  requiredSections: profile.sectionRules.filter((r) => r.required).map((r) => `${r.heading}(${(r.ratio * 100).toFixed(0)}%)`),
  introLength: profile.introRules.length,
  introParagraphs: profile.introRules.paragraphs,
  dimensionInIntroRatio: profile.sizePlacementRules.dimensionInIntroRatio,
  dimensionPlacement: profile.sizePlacementRules.placement.slice(0, 4),
  brandRules: { latin: profile.brandRules.latinWithKanaReadingRatio, startsWith: profile.brandRules.startsWithBrandRatio, top: profile.brandRules.topBrands.slice(0, 8).map((b) => `${b.value}(${b.observedCount})`) },
  politeSentenceRatio: profile.toneRules.politeSentenceRatio,
  unusedSymbols: profile.toneRules.unusedSymbols,
  usedSymbols: profile.toneRules.usedSymbols.map((s) => `${s.value}(${s.observedCount})`),
  preferredPhrases: profile.preferredPhrases.slice(0, 10).map((p) => `${p.value}(${p.observedCount})`),
  categories: profile.categoryDistribution.slice(0, 8).map((c) => `${c.value}(${c.observedCount})`),
  priceBands: profile.priceBands.map((p) => `${p.value}(${p.observedCount})`),
}, null, 1));
