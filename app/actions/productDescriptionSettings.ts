"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { canEditInventory, getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import {
  activateCurrentSettings,
  createGuidanceRule,
  listGuidanceRules,
  listSettingVersions,
  restoreSettingVersion,
  updateGuidanceRule,
  type GuidanceRule,
  type SettingVersion,
} from "@/lib/ai/productPage/guidance";
import { loadActiveStyleProfile, generateCanonicalProductPage } from "@/lib/ai/productPage/canonical";
import { buildGuidanceBlock } from "@/lib/ai/productPage/guidance";
import { generateProductPage } from "@/lib/ai/productPage/service";
import { loadStyleArchive } from "@/lib/ai/productPage/canonical";
import { getInventoryDetail } from "@/lib/inventory/queries";
import { listAllMasterEntries } from "@/lib/inventory/masters";
import { baseBrandHint } from "@/lib/base/archive/similar";
import type { BelloStyleProfile } from "@/lib/ai/productIntro/styleProfile";

/**
 * 設定 ＞ 商品説明文 のServer Action層(2026-09-02 追加仕様§1〜§10)。
 *
 * 読み取りは ADMIN/EDITOR/VIEWER、書き込みは ADMIN/EDITOR
 * (他の設定パネルと同じ境界)。
 */

async function requireRead(): Promise<void> {
  const role = await getInventoryRole();
  if (!role) throw new Error("ログインが必要です。");
}

async function requireWrite(): Promise<string | null> {
  const role = await getInventoryRole();
  if (!canEditInventory(role)) throw new Error("この操作にはADMINまたはEDITOR権限が必要です。");
  return getCurrentInventoryUserEmail();
}

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string; correlationId: string };

function fail(err: unknown, fallback: string): { ok: false; error: string; correlationId: string } {
  const correlationId = randomUUID();
  console.error(JSON.stringify({ level: "error", correlationId, message: err instanceof Error ? err.message : String(err) }));
  return { ok: false, error: err instanceof Error ? err.message : fallback, correlationId };
}

/**
 * 文体プロファイルを人間向けに整えた形(追加仕様§2/§3)。
 *
 * JSONをそのまま管理者へ見せて終わりにしない。ただし**存在しない分析値を
 * 作らない** —— Profileに無い統計はここでも出さない。
 */
export interface StyleProfileSummary {
  version: number;
  generatedAt: string;
  analyzedItemCount: number;
  introExtractedCount: number;
  analysisPeriod: { start: string | null; end: string | null };
  confidence: number;
  /** confidence が何を意味するか(追加仕様§3)。実装と一致する説明だけを出す。 */
  confidenceExplanation: {
    formula: string;
    sampleScore: number;
    extractionScore: number;
    meaning: string;
  };
  sectionRules: { heading: string; ratio: number; averageOrder: number }[];
  recommendedSectionOrder: string[];
  introLength: { median: number; min: number; max: number };
  introParagraphs: { median: number; min: number; max: number };
  commonOpeningForms: { value: string; ratio: number }[];
  commonClosingForms: { value: string; ratio: number }[];
  dimensionInIntroRatio: number;
  dimensionPlacement: { value: string; ratio: number }[];
  politeSentenceRatio: number;
  latinWithKanaReadingRatio: number;
  startsWithBrandRatio: number;
  unusedSymbols: string[];
  preferredPhrases: { value: string; ratio: number }[];
  prohibitedPhrases: string[];
  topBrands: { value: string; ratio: number }[];
  categoryDistribution: { value: string; ratio: number }[];
}

const SECTION_HEADING: Record<string, string> = {
  INTRO: "◎商品のご紹介",
  TARGET: "こんな空間を求めている方に",
  DETAIL: "商品詳細（寸法はここ）",
  SIZE: "サイズ",
  CONDITION: "コンディション",
  CONDITION_SCALE: "状態ランク基準",
  SHIPPING: "発送について",
  RESERVATION: "お取り置きについて",
  NOTICE: "ご注意",
  LINKS: "関連リンク / SALE",
};

function summarize(profile: BelloStyleProfile, version: number): StyleProfileSummary {
  // computeConfidence(total, extracted) = min(1, total/200) * (extracted/total)
  // を、実装と同じ式でそのまま分解して見せる。別の説明を作らない。
  const sampleScore = Math.min(1, profile.analyzedItemCount / 200);
  const extractionScore = profile.analyzedItemCount === 0 ? 0 : profile.introExtractedCount / profile.analyzedItemCount;

  const obs = (o: { value: string; ratio: number }[] | undefined) =>
    (o ?? []).map((x) => ({ value: String(x.value), ratio: x.ratio }));

  return {
    version,
    generatedAt: profile.generatedAt,
    analyzedItemCount: profile.analyzedItemCount,
    introExtractedCount: profile.introExtractedCount,
    analysisPeriod: profile.analysisPeriod,
    confidence: profile.confidence,
    confidenceExplanation: {
      formula: "min(1, 分析件数 ÷ 200) × (紹介文を抽出できた件数 ÷ 分析件数)",
      sampleScore,
      extractionScore,
      meaning:
        "「どれだけ多くの商品を見たか」と「そのうち紹介文をきちんと切り出せた割合」だけから決まる値です。" +
        "文章の良し悪しや、生成結果の正しさを表すものではありません。" +
        "分析件数が200件を超えると前半は1で頭打ちになるため、実質的には紹介文の抽出成功率と同じ値になります。",
    },
    sectionRules: (profile.sectionRules ?? []).map((r) => ({
      heading: SECTION_HEADING[r.kind] ?? r.kind,
      ratio: r.ratio,
      averageOrder: r.averageOrder,
    })),
    recommendedSectionOrder: (profile.recommendedSectionOrder ?? []).map((k) => SECTION_HEADING[k] ?? k),
    introLength: { median: profile.introRules.length.median, min: profile.introRules.length.min, max: profile.introRules.length.max },
    introParagraphs: {
      median: profile.introRules.paragraphs.median,
      min: profile.introRules.paragraphs.min,
      max: profile.introRules.paragraphs.max,
    },
    commonOpeningForms: obs(profile.introRules.commonOpeningForms as never),
    commonClosingForms: obs(profile.introRules.commonClosingForms as never),
    dimensionInIntroRatio: profile.sizePlacementRules.dimensionInIntroRatio,
    dimensionPlacement: (profile.sizePlacementRules.placement ?? []).map((p) => ({
      value: SECTION_HEADING[p.value as string] ?? String(p.value),
      ratio: p.ratio,
    })),
    politeSentenceRatio: profile.toneRules.politeSentenceRatio,
    latinWithKanaReadingRatio: profile.brandRules.latinWithKanaReadingRatio,
    startsWithBrandRatio: profile.brandRules.startsWithBrandRatio,
    unusedSymbols: profile.toneRules.unusedSymbols ?? [],
    preferredPhrases: obs(profile.preferredPhrases as never),
    prohibitedPhrases: profile.prohibitedPhrases ?? [],
    topBrands: obs(profile.brandRules.topBrands as never),
    categoryDistribution: obs(profile.categoryDistribution as never),
  };
}

export interface ProductDescriptionSettingsView {
  styleProfile: StyleProfileSummary | null;
  guidance: GuidanceRule[];
  versions: SettingVersion[];
  archiveSize: number;
}

export async function getProductDescriptionSettingsAction(): Promise<ActionResult<ProductDescriptionSettingsView>> {
  try {
    await requireRead();
    const [profile, guidance, versions, archive] = await Promise.all([
      loadActiveStyleProfile(),
      listGuidanceRules(),
      listSettingVersions(),
      loadStyleArchive(),
    ]);
    return {
      ok: true,
      data: {
        styleProfile: profile ? summarize(profile.profile, profile.version) : null,
        guidance,
        versions,
        archiveSize: archive.length,
      },
    };
  } catch (err) {
    return fail(err, "商品説明文の設定を読み込めませんでした。");
  }
}

export async function createGuidanceAction(instruction: string): Promise<ActionResult<GuidanceRule>> {
  try {
    const who = await requireWrite();
    const rule = await createGuidanceRule(instruction, who);
    revalidatePath("/inventory/settings");
    return { ok: true, data: rule };
  } catch (err) {
    return fail(err, "改善指示を保存できませんでした。");
  }
}

export async function updateGuidanceAction(
  id: string,
  input: { instruction?: string; enabled?: boolean },
): Promise<ActionResult<GuidanceRule>> {
  try {
    const who = await requireWrite();
    const rule = await updateGuidanceRule(id, input, who);
    revalidatePath("/inventory/settings");
    return { ok: true, data: rule };
  } catch (err) {
    return fail(err, "改善指示を更新できませんでした。");
  }
}

export async function activateSettingsAction(note: string): Promise<ActionResult<SettingVersion>> {
  try {
    const who = await requireWrite();
    const profile = await loadActiveStyleProfile();
    const version = await activateCurrentSettings({
      note: note.trim() || null,
      styleProfileVersion: profile?.version ?? null,
      who,
    });
    revalidatePath("/inventory/settings");
    return { ok: true, data: version };
  } catch (err) {
    return fail(err, "設定を反映できませんでした。");
  }
}

export async function restoreSettingsVersionAction(versionId: string): Promise<ActionResult<SettingVersion>> {
  try {
    const who = await requireWrite();
    const version = await restoreSettingVersion(versionId, who);
    revalidatePath("/inventory/settings");
    return { ok: true, data: version };
  } catch (err) {
    return fail(err, "設定を復元できませんでした。");
  }
}

export interface TestGenerationResult {
  inventoryId: string;
  inventoryName: string;
  /** 使用した確定事実(顧客に出して安全な形へ整えたもの)。 */
  usedFacts: { label: string; value: string }[];
  styleProfileVersion: number | null;
  referencedBaseItemIds: string[];
  appliedGuidance: string[];
  title: string | null;
  fullDescription: string | null;
  introduction: string | null;
  violations: string[];
  missingFacts: string[];
  introSanitized: boolean;
  genericPhrases: string[];
}

function toTestResult(
  result: Awaited<ReturnType<typeof generateCanonicalProductPage>>,
): TestGenerationResult {
  return {
    inventoryId: result.inventoryId,
    inventoryName: result.inventoryName,
    usedFacts: [],
    styleProfileVersion: result.usedStyleProfileVersion,
    referencedBaseItemIds: result.referencedBaseItemIds,
    appliedGuidance: result.activeGuidance.map((g) => g.instruction),
    title: result.sections?.title ?? null,
    fullDescription: result.fullDescription,
    introduction: result.sections?.introduction ?? null,
    violations: result.violations.map((v) => v.detail),
    missingFacts: result.missingFacts,
    introSanitized: result.introSanitized ?? false,
    genericPhrases: result.genericPhrases ?? [],
  };
}

/** §7 現在の設定でテスト生成する(ACTIVEな改善指示がそのまま効く)。 */
export async function testGenerateAction(inventoryId: string): Promise<ActionResult<TestGenerationResult>> {
  try {
    await requireWrite();
    const result = await generateCanonicalProductPage(inventoryId);
    return { ok: true, data: toTestResult(result) };
  } catch (err) {
    return fail(err, "テスト生成に失敗しました。");
  }
}

/**
 * §8 Before / After 比較。
 *
 * Before = 現在の正式設定(ACTIVEな改善指示)
 * After  = 変更候補(画面で編集中の指示。まだ保存していないものを含む)
 *
 * どちらも同じ商品・同じ Style Profile・同じ類似商品で生成するので、
 * 差が出たとすれば改善指示の違いによる。**保存しないまま比較できる**
 * ようにしてあるのが要点で、「保存しただけで全生成挙動が変わる」ことを
 * 避けるための設計(§8)。
 */
export async function compareGenerationAction(
  inventoryId: string,
  candidateInstructions: string[],
): Promise<ActionResult<{ before: TestGenerationResult; after: TestGenerationResult }>> {
  try {
    await requireWrite();

    const item = await getInventoryDetail(inventoryId);
    if (!item) throw new Error("対象の在庫が見つかりません。");
    const [archive, profile, categories, activeGuidance] = await Promise.all([
      loadStyleArchive(),
      loadActiveStyleProfile(),
      listAllMasterEntries("Category"),
      listGuidanceRules(),
    ]);
    const categoryName = categories.find((c: { id: string; name: string }) => c.id === item.categoryId)?.name ?? null;

    const shared = {
      inventoryId: item.id,
      name: item.name,
      categoryName,
      width: item.width ? String(item.width) : null,
      depth: item.depth ? String(item.depth) : null,
      height: item.height ? String(item.height) : null,
      damageNotes: item.damageNotes ?? null,
      note: item.note ?? null,
      conditionRating: item.conditionRating ?? null,
      stockQuantity: item.quantity ?? null,
      sku: item.sku ?? null,
      price: item.salePrice ?? item.plannedSalePrice ?? null,
      brand: baseBrandHint(item.name),
      archive,
      styleProfile: profile?.profile ?? null,
      styleProfileVersion: profile?.version ?? null,
    };

    const activeTexts = activeGuidance.filter((g) => g.enabled).map((g) => g.instruction);
    const candidateTexts = candidateInstructions.map((s) => s.trim()).filter(Boolean);

    const asRules = (texts: string[]): GuidanceRule[] =>
      texts.map((instruction, i) => ({
        id: `candidate-${i}`,
        instruction,
        enabled: true,
        sortOrder: i,
        version: 1,
        createdBy: null,
        updatedBy: null,
        createdAt: "",
        updatedAt: "",
      }));

    const [before, after] = await Promise.all([
      generateProductPage({ ...shared, guidanceBlock: buildGuidanceBlock(asRules(activeTexts)), appliedGuidance: activeTexts }),
      generateProductPage({ ...shared, guidanceBlock: buildGuidanceBlock(asRules(candidateTexts)), appliedGuidance: candidateTexts }),
    ]);

    const wrap = (r: Awaited<ReturnType<typeof generateProductPage>>, applied: string[]): TestGenerationResult => ({
      inventoryId: item.id,
      inventoryName: item.name,
      usedFacts: [],
      styleProfileVersion: profile?.version ?? null,
      referencedBaseItemIds: r.referencedBaseItemIds,
      appliedGuidance: applied,
      title: r.sections?.title ?? null,
      fullDescription: r.fullDescription,
      introduction: r.sections?.introduction ?? null,
      violations: r.violations.map((v) => v.detail),
      missingFacts: r.missingFacts,
      introSanitized: r.introSanitized ?? false,
      genericPhrases: r.genericPhrases ?? [],
    });

    return { ok: true, data: { before: wrap(before, activeTexts), after: wrap(after, candidateTexts) } };
  } catch (err) {
    return fail(err, "Before/After比較に失敗しました。");
  }
}
