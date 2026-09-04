/**
 * 佐川急便のサイズ区分判定(2026-09-04 EC出品改修指示書 §9)。
 *
 * ── 家財おまかせ便のランク判定(rank.ts)とは別物 ──────────────────
 *
 * 家財おまかせ便は「3辺合計そのもの」で9段階のランクを決める。
 * こちらは**梱包した後の荷物**のサイズ区分で、区分の刻みも上限も違う。
 * 混ぜると、送料計算(rank.ts が正本)と商品説明が食い違う。§8が禁じて
 * いるのはその状態なので、**判定表は別ファイルに分け、どちらも
 * 「外形3辺をどう読むか」だけは rank.ts の resolveOuterDimensionCm を
 * 共有する**(座面寸法やSH/AHを辺として拾わない、という保証を1箇所に
 * 持たせるため)。
 *
 * ── 梱包余裕分 +20cm(§9) ─────────────────────────────────────────
 *
 * 商品そのものの3辺合計ではなく、梱包後を見積もって +20cm した値で
 * 区分を決める。判定値はそのまま使わず、**次の区分へ切り上げる** ——
 * §9-1 の例(幅60/奥行40/高さ30 → 130 → +20 → 150 → 160サイズ)。
 * 「150サイズ」のような存在しない区分を作らない。
 */
import { resolveOuterDimensionCm } from "./rank";

/** 梱包余裕分。商品の3辺合計へ加算してから区分を決める(§9)。 */
export const SAGAWA_PACKING_ALLOWANCE_CM = 20;

/** 佐川急便のサイズ区分(cm)と重量上限(kg)。 */
export interface SagawaSizeClass {
  /** 区分値。60/80/…/260。 */
  size: number;
  /** この区分の3辺合計上限(cm)。 */
  maxSumCm: number;
  /** この区分の重量上限(kg)。 */
  maxWeightKg: number;
  /** 通常サイズか、飛脚ラージサイズ宅配便か。 */
  service: "STANDARD" | "LARGE";
}

/**
 * 区分表(§9)。
 *
 * 通常サイズは 60/80/100/140/160 の5段階で、**120サイズは無い**
 * (指示書の一覧にも無い)。飛脚ラージサイズ宅配便は170〜260。
 * ラージサイズの重量上限は最大50kg。
 */
export const SAGAWA_SIZE_CLASSES: SagawaSizeClass[] = [
  { size: 60, maxSumCm: 60, maxWeightKg: 2, service: "STANDARD" },
  { size: 80, maxSumCm: 80, maxWeightKg: 5, service: "STANDARD" },
  { size: 100, maxSumCm: 100, maxWeightKg: 10, service: "STANDARD" },
  { size: 140, maxSumCm: 140, maxWeightKg: 20, service: "STANDARD" },
  { size: 160, maxSumCm: 160, maxWeightKg: 30, service: "STANDARD" },
  { size: 170, maxSumCm: 170, maxWeightKg: 50, service: "LARGE" },
  { size: 180, maxSumCm: 180, maxWeightKg: 50, service: "LARGE" },
  { size: 200, maxSumCm: 200, maxWeightKg: 50, service: "LARGE" },
  { size: 220, maxSumCm: 220, maxWeightKg: 50, service: "LARGE" },
  { size: 240, maxSumCm: 240, maxWeightKg: 50, service: "LARGE" },
  { size: 260, maxSumCm: 260, maxWeightKg: 50, service: "LARGE" },
];

/** 佐川急便で扱える最大の3辺合計(cm)と重量(kg)。 */
export const SAGAWA_MAX_SUM_CM = 260;
export const SAGAWA_MAX_WEIGHT_KG = 50;

export const SAGAWA_SERVICE_LABEL: Record<SagawaSizeClass["service"], string> = {
  STANDARD: "飛脚宅配便",
  LARGE: "飛脚ラージサイズ宅配便",
};

export type SagawaUnavailableReason =
  /** 3辺のどれかが読めない(§10 判定不能)。 */
  | "DIMENSIONS_MISSING"
  /** 3辺合計 + 梱包余裕が260cmを超える。 */
  | "OVER_MAX_SIZE"
  /** 重量が50kgを超える。 */
  | "OVER_MAX_WEIGHT";

export interface SagawaSizeResult {
  /** 判定できた区分。できなければ null。 */
  sizeClass: SagawaSizeClass | null;
  /** 商品そのものの3辺合計(cm)。読めなければ null。 */
  productSumCm: number | null;
  /** 梱包余裕を足した判定値(cm)。読めなければ null。 */
  judgedSumCm: number | null;
  /** 重量(kg)。渡されなければ null。 */
  weightKg: number | null;
  /** 判定できなかった理由。判定できたなら null。 */
  unavailableReason: SagawaUnavailableReason | null;
  /** 人が読む説明(画面と警告に出す)。 */
  note: string;
}

/**
 * 判定値(cm)から区分を決める。**切り上げ**なので、境界値はその区分に
 * 収まる(60→60サイズ、61→80サイズ)。
 */
export function sagawaSizeClassForSum(judgedSumCm: number): SagawaSizeClass | null {
  if (!Number.isFinite(judgedSumCm) || judgedSumCm <= 0) return null;
  return SAGAWA_SIZE_CLASSES.find((c) => judgedSumCm <= c.maxSumCm) ?? null;
}

/** 重量から下限となる区分を決める(重い荷物は寸法が小さくても上の区分になる)。 */
export function sagawaSizeClassForWeight(weightKg: number): SagawaSizeClass | null {
  if (!Number.isFinite(weightKg) || weightKg <= 0) return null;
  return SAGAWA_SIZE_CLASSES.find((c) => weightKg <= c.maxWeightKg) ?? null;
}

/**
 * 3辺(cm)と、分かっていれば重量から、佐川急便のサイズ区分を決める。
 *
 * 寸法の区分と重量の区分の**大きいほう**を採る。3辺合計が小さくても
 * 重ければ上の区分になるのが実際の運用で、小さく見積もると実際の請求と
 * 食い違う(rank.ts が同じ理由で座面寸法を除外しているのと同じ考え方)。
 */
export function resolveSagawaSizeFromCm(input: {
  widthCm: number | null;
  depthCm: number | null;
  heightCm: number | null;
  weightKg?: number | null;
}): SagawaSizeResult {
  const weightKg = input.weightKg != null && Number.isFinite(input.weightKg) && input.weightKg > 0 ? input.weightKg : null;

  if (input.widthCm == null || input.depthCm == null || input.heightCm == null) {
    return {
      sizeClass: null,
      productSumCm: null,
      judgedSumCm: null,
      weightKg,
      unavailableReason: "DIMENSIONS_MISSING",
      note: "幅・奥行・高さのいずれかを読み取れないため、佐川急便のサイズを判定できません。",
    };
  }

  const productSumCm = input.widthCm + input.depthCm + input.heightCm;
  // §9 梱包余裕分。**商品の3辺合計ではなく、この値で区分を決める。**
  const judgedSumCm = productSumCm + SAGAWA_PACKING_ALLOWANCE_CM;

  if (weightKg != null && weightKg > SAGAWA_MAX_WEIGHT_KG) {
    return {
      sizeClass: null,
      productSumCm,
      judgedSumCm,
      weightKg,
      unavailableReason: "OVER_MAX_WEIGHT",
      note: `重量${weightKg}kgが佐川急便の上限(${SAGAWA_MAX_WEIGHT_KG}kg)を超えるため、サイズを判定できません。`,
    };
  }

  const bySize = sagawaSizeClassForSum(judgedSumCm);
  if (!bySize) {
    return {
      sizeClass: null,
      productSumCm,
      judgedSumCm,
      weightKg,
      unavailableReason: "OVER_MAX_SIZE",
      note: `3辺合計${productSumCm}cm + 梱包余裕${SAGAWA_PACKING_ALLOWANCE_CM}cm = ${judgedSumCm}cm が佐川急便の上限(${SAGAWA_MAX_SUM_CM}cm)を超えるため、サイズを判定できません。`,
    };
  }

  const byWeight = weightKg != null ? sagawaSizeClassForWeight(weightKg) : null;
  const sizeClass = byWeight && byWeight.size > bySize.size ? byWeight : bySize;

  const weightNote =
    byWeight && byWeight.size > bySize.size
      ? `（寸法では${bySize.size}サイズですが、重量${weightKg}kgのため${sizeClass.size}サイズ）`
      : "";
  return {
    sizeClass,
    productSumCm,
    judgedSumCm,
    weightKg,
    unavailableReason: null,
    note: `3辺合計${productSumCm}cm + 梱包余裕${SAGAWA_PACKING_ALLOWANCE_CM}cm = ${judgedSumCm}cm → ${SAGAWA_SERVICE_LABEL[sizeClass.service]}${sizeClass.size}サイズ${weightNote}`,
  };
}

/**
 * BELLOの自由入力の寸法文字列から判定する。
 *
 * 外形3辺の読み取りは rank.ts の resolveOuterDimensionCm に任せる ——
 * 座面寸法・SH・AH・内寸・3辺合計を辺として拾わない保証を、家財便と
 * 佐川で二重に書かない。
 */
export function resolveSagawaSize(input: {
  width?: string | null;
  depth?: string | null;
  height?: string | null;
  weightKg?: number | null;
}): SagawaSizeResult {
  return resolveSagawaSizeFromCm({
    widthCm: resolveOuterDimensionCm(input.width).valueCm,
    depthCm: resolveOuterDimensionCm(input.depth).valueCm,
    heightCm: resolveOuterDimensionCm(input.height).valueCm,
    weightKg: input.weightKg ?? null,
  });
}

/** 画面・説明文に出す表記。「飛脚ラージサイズ宅配便170サイズ」。 */
export function formatSagawaSize(result: SagawaSizeResult): string | null {
  if (!result.sizeClass) return null;
  return `${SAGAWA_SERVICE_LABEL[result.sizeClass.service]}${result.sizeClass.size}サイズ`;
}
