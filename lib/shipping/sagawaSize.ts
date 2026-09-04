/**
 * 佐川急便のサイズ区分判定(2026-09-04 EC出品改修指示書 §9 / 追加指示 §2)。
 *
 * ── 家財便のランク判定(rank.ts)とは別物 ─────────────────────────
 *
 * らくらく家財便は「3辺合計そのもの」で9段階のランクを決める。
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
 *
 * ── 重量は見ない(追加指示 §2) ────────────────────────────────────
 *
 * 「当店では基本的にサイズを基準として配送判断を行っているため、
 * 佐川急便についても重量条件によるブロックや警告は不要」。
 * BELLOには重量の項目がそもそも無く、あるふりをした分岐を残しておくと
 * 「重量が無いので判定できません」という**実際には起きない警告**の
 * 経路が残る。判定は 3辺合計 + 20cm だけで確定させる。
 */
import { resolveOuterDimensionCm } from "./rank";

/** 梱包余裕分。商品の3辺合計へ加算してから区分を決める(§9)。 */
export const SAGAWA_PACKING_ALLOWANCE_CM = 20;

/** 佐川急便のサイズ区分(cm)。 */
export interface SagawaSizeClass {
  /** 区分値。60/80/…/260。 */
  size: number;
  /** この区分の3辺合計上限(cm)。 */
  maxSumCm: number;
  /** 通常サイズか、飛脚ラージサイズ宅配便か。 */
  service: "STANDARD" | "LARGE";
}

/**
 * 区分表(§9)。
 *
 * 通常サイズは 60/80/100/140/160 の5段階で、**120サイズは無い**
 * (指示書の一覧にも無い)。飛脚ラージサイズ宅配便は170〜260。
 */
export const SAGAWA_SIZE_CLASSES: SagawaSizeClass[] = [
  { size: 60, maxSumCm: 60, service: "STANDARD" },
  { size: 80, maxSumCm: 80, service: "STANDARD" },
  { size: 100, maxSumCm: 100, service: "STANDARD" },
  { size: 140, maxSumCm: 140, service: "STANDARD" },
  { size: 160, maxSumCm: 160, service: "STANDARD" },
  { size: 170, maxSumCm: 170, service: "LARGE" },
  { size: 180, maxSumCm: 180, service: "LARGE" },
  { size: 200, maxSumCm: 200, service: "LARGE" },
  { size: 220, maxSumCm: 220, service: "LARGE" },
  { size: 240, maxSumCm: 240, service: "LARGE" },
  { size: 260, maxSumCm: 260, service: "LARGE" },
];

/** 佐川急便で扱える最大の3辺合計(cm)。 */
export const SAGAWA_MAX_SUM_CM = 260;

export const SAGAWA_SERVICE_LABEL: Record<SagawaSizeClass["service"], string> = {
  STANDARD: "佐川急便",
  LARGE: "佐川急便（飛脚ラージサイズ宅配便）",
};

export type SagawaUnavailableReason =
  /** 3辺のどれかが読めない(§10 判定不能)。 */
  | "DIMENSIONS_MISSING"
  /** 3辺合計 + 梱包余裕が260cmを超える。 */
  | "OVER_MAX_SIZE";

export interface SagawaSizeResult {
  /** 判定できた区分。できなければ null。 */
  sizeClass: SagawaSizeClass | null;
  /** 商品そのものの3辺合計(cm)。読めなければ null。 */
  productSumCm: number | null;
  /** 梱包余裕を足した判定値(cm)。読めなければ null。 */
  judgedSumCm: number | null;
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

/** 3辺(cm)から佐川急便のサイズ区分を決める。 */
export function resolveSagawaSizeFromCm(input: {
  widthCm: number | null;
  depthCm: number | null;
  heightCm: number | null;
}): SagawaSizeResult {
  if (input.widthCm == null || input.depthCm == null || input.heightCm == null) {
    return {
      sizeClass: null,
      productSumCm: null,
      judgedSumCm: null,
      unavailableReason: "DIMENSIONS_MISSING",
      note: "幅・奥行・高さのいずれかを読み取れないため、佐川急便のサイズを判定できません。",
    };
  }

  const productSumCm = input.widthCm + input.depthCm + input.heightCm;
  // §9 梱包余裕分。**商品の3辺合計ではなく、この値で区分を決める。**
  const judgedSumCm = productSumCm + SAGAWA_PACKING_ALLOWANCE_CM;

  const sizeClass = sagawaSizeClassForSum(judgedSumCm);
  if (!sizeClass) {
    return {
      sizeClass: null,
      productSumCm,
      judgedSumCm,
      unavailableReason: "OVER_MAX_SIZE",
      note: `3辺合計${productSumCm}cm + 梱包余裕${SAGAWA_PACKING_ALLOWANCE_CM}cm = ${judgedSumCm}cm が佐川急便の上限(${SAGAWA_MAX_SUM_CM}cm)を超えるため、サイズを判定できません。`,
    };
  }

  return {
    sizeClass,
    productSumCm,
    judgedSumCm,
    unavailableReason: null,
    note: `3辺合計${productSumCm}cm + 梱包余裕${SAGAWA_PACKING_ALLOWANCE_CM}cm = ${judgedSumCm}cm → ${sizeClass.size}サイズ`,
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
}): SagawaSizeResult {
  return resolveSagawaSizeFromCm({
    widthCm: resolveOuterDimensionCm(input.width).valueCm,
    depthCm: resolveOuterDimensionCm(input.depth).valueCm,
    heightCm: resolveOuterDimensionCm(input.height).valueCm,
  });
}

/**
 * 商品説明に出す表記。「佐川急便160サイズ」。
 *
 * 追加指示§1の例文が「佐川急便160サイズ」なので、通常サイズはその形。
 * 170以上は飛脚ラージサイズ宅配便という別サービスなので、そのことが
 * 分かる表記にする(顧客が送料や日数を調べるときに名前が違うと辿れない)。
 */
export function formatSagawaSize(result: SagawaSizeResult): string | null {
  if (!result.sizeClass) return null;
  return `${SAGAWA_SERVICE_LABEL[result.sizeClass.service]}${result.sizeClass.size}サイズ`;
}

/** 画面(右パネル)に出す短い表記。サービス名を含めず区分だけ。 */
export function formatSagawaSizeShort(result: SagawaSizeResult): string | null {
  if (!result.sizeClass) return null;
  return `${result.sizeClass.size}サイズ${result.sizeClass.service === "LARGE" ? "（飛脚ラージサイズ宅配便）" : ""}`;
}
