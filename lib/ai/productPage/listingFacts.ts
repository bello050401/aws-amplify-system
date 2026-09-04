/**
 * 商品説明生成へ渡す Product Context(2026-09-04 EC出品改修指示書 §20)。
 *
 * ── 新しい仕組みを作らない ──────────────────────────────────────
 *
 * §20「既存Product Contextがある場合、新しい仕組みを重複して作らず拡張
 * してください」。事実の安全化は既存の `buildCustomerSafeFacts`
 * (社内スコア・住所・金額・【】マーカーの除去)をそのまま通す。
 * このファイルが足すのは、**既存では拾っていなかった項目**だけ:
 *
 *   座面寸法 / 材質 / メンテナンス実施内容 / 家財便ランク / 佐川サイズ
 *
 * ── 純粋関数 ────────────────────────────────────────────────────
 *
 * DBにも外部にも触らない。呼び出し側(canonical.ts)が在庫を読んで渡す。
 * これにより scripts/verify-listing-description.ts が実AWS無しで
 * 全分岐を固定できる。
 */
import { buildCustomerSafeFacts, type CustomerSafeFacts, type FactRedaction } from "@/lib/ai/productIntro/facts";
import {
  detectMaintenance,
  looksNonFabric,
  stripMaintenanceOnlyLines,
  type MaintenanceResult,
} from "@/lib/inventory/maintenance";
import { resolveSeatDimensions, type SeatDimensions } from "@/lib/inventory/seatDimensions";
import { calculateShippingRankFromDimensionsDetailed, type ShippingRank } from "@/lib/shipping/rank";
import { resolveSagawaSize, type SagawaSizeResult } from "@/lib/shipping/sagawaSize";

/** 生成へ渡す在庫の生データ(呼び出し側が Inventory から詰める)。 */
export interface ListingFactsInput {
  name: string;
  categoryName: string | null;
  brand: string | null;
  /** 在庫の寸法。BASEから補完済みの値が入ることもある(canonical.ts)。 */
  width: string | null;
  depth: string | null;
  height: string | null;
  overallLength: string | null;
  /** CustomField `seatDimensions`(ZAICO「⚪︎座面寸法」)。 */
  seatDimensionsField: string | null;
  /** CustomField `material`(ZAICO「⚪︎材質」)。 */
  material: string | null;
  conditionRating: string | null;
  damageNotes: string | null;
  note: string | null;
  listingNotes: string | null;
  adminMemo: string | null;
  /** 重量(kg)。BELLOには現在この項目が無いので通常は null。 */
  weightKg?: number | null;
}

export interface ListingFacts {
  /** 既存の顧客向け安全事実(商品名・寸法・カテゴリ・状態・備考)。 */
  safe: CustomerSafeFacts;
  redactions: FactRedaction[];
  brand: string | null;
  /** 素材。CustomField `material` から。無ければ null。 */
  material: string | null;
  /** ZAICO由来の寸法(◎商品詳細へそのまま書く)。 */
  width: string | null;
  depth: string | null;
  height: string | null;
  overallLength: string | null;
  seat: SeatDimensions;
  maintenance: MaintenanceResult;
  /** ファブリックが明らかに無いか(§12)。 */
  nonFabric: boolean;
  /** 家財おまかせ便のランク。判定できなければ null(§10)。 */
  shippingRank: ShippingRank | null;
  /** ランクを判定できなかった理由(担当者向け)。 */
  shippingRankReason: string | null;
  /** 送料判定に使った3辺合計(cm)。 */
  shippingSumCm: number | null;
  /** 佐川急便のサイズ区分(§9)。 */
  sagawa: SagawaSizeResult;
  /** 「良好」と書いてよい根拠があるか(§14)。 */
  goodConditionEvidence: boolean;
  /** 担当者へ出す警告(§21)。 */
  warnings: string[];
}

/**
 * 社内のコンディション評価から「良好」と書いてよいかを決める。
 *
 * 実データの `conditionRating` はほぼ 5段階のスコア("4" / "3.5")で、
 * **顧客向けの文章ではない**(facts.ts のコメントに実測)。数値そのものは
 * 顧客へ出さないが、「良好」と書いてよいかの判断材料としては使える。
 *
 * 4.0以上を良好とする。3.5を良好に含めない —— 中間の評価を良好と
 * 言い切ると、実物との差で受取評価前の相談が増える。
 * 文章で書かれている場合は、良好と読める語があるときだけ true。
 */
export const GOOD_CONDITION_MIN_SCORE = 4;

export function hasGoodConditionEvidence(conditionRating: string | null | undefined): boolean {
  const raw = conditionRating?.trim();
  if (!raw) return false;
  const normalized = raw.replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const numeric = normalized.match(/^\s*(\d+(?:\.\d+)?)\s*$/);
  if (numeric) return Number(numeric[1]) >= GOOD_CONDITION_MIN_SCORE;
  // 文章で書かれている場合。
  //
  // **「傷が無い」を先に見る。** 「目立つ傷なし」は傷の語を含むので、
  // 傷の語の有無だけで判定すると良好の記述まで否定してしまう(実際に
  // それでテストが落ちた)。無い、と書かれているものを先に拾う。
  if (/(傷|汚れ|スレ|擦れ)\s*(?:は|も)?\s*(?:ほとんど)?(?:な|無)[しく]/.test(normalized)) return true;
  // 傷・汚れが「ある」と読める記述があれば良好ではない。
  if (/(傷|汚れ|ダメージ|破れ|欠け|割れ|ヘタり|使用感|打痕|色褪せ|補修)/.test(normalized)) return false;
  return /(良好|美品|きれい|綺麗)/.test(normalized);
}

/** 素材の値として使える文字列か。ZAICOには "-" や "不明" が入ることがある。 */
function usableMaterial(value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  if (/^(-|―|なし|無し|不明|未確認|\?|？)$/.test(v)) return null;
  return v;
}

/**
 * 在庫1件から Product Context を組み立てる。
 *
 * **足りないものを埋めない。** 取れなかった項目は null のまま返し、
 * 何が取れなかったかを warnings に積む(§21)。
 */
export function buildListingFacts(input: ListingFactsInput): ListingFacts {
  // ── メンテナンスの判定を先に済ませる ────────────────────────
  //
  // 傷汚れメモにはメンテナンスの記録が混ざっている(実測: `damageNotes =
  // "リンサー"` が71件)。**判定は元の文字列に対して行い**、顧客向けの
  // 状態説明としてはメンテナンスだけの行を落とす。順序を逆にすると、
  // リンサーの記録そのものを落としてから探すことになり、何も見つからない。
  const maintenance = detectMaintenance({
    name: input.name,
    damageNotes: input.damageNotes,
    note: input.note,
    listingNotes: input.listingNotes,
    conditionRating: input.conditionRating,
    adminMemo: input.adminMemo,
  });

  const { facts, redactions } = buildCustomerSafeFacts({
    name: input.name,
    width: input.width,
    depth: input.depth,
    height: input.height,
    categoryName: input.categoryName,
    conditionRating: input.conditionRating,
    // 社内語がそのまま顧客向けの状態説明にならないようにする。
    damageNotes: stripMaintenanceOnlyLines(input.damageNotes),
    note: input.note,
  });

  const seat = resolveSeatDimensions({
    seatDimensionsField: input.seatDimensionsField,
    width: input.width,
    depth: input.depth,
    height: input.height,
  });

  const material = usableMaterial(input.material);
  const nonFabric = looksNonFabric({ name: input.name, material, categoryName: input.categoryName });

  // ── 家財おまかせ便のランク(§8 既存ロジックを再利用) ────────────
  //
  // 送料計算(lib/shipping/service.ts)と同じ関数を通す。別ロジックを
  // 書くと、送料の表示と商品説明が食い違う状態になる。
  const rankResult = calculateShippingRankFromDimensionsDetailed(input.width, input.depth, input.height);
  const shippingRank = "rank" in rankResult ? rankResult.rank : null;
  const shippingSumCm = "sumCm" in rankResult ? rankResult.sumCm : null;
  const shippingRankReason =
    "missingAxes" in rankResult
      ? `送料判定に使える外形寸法を読み取れませんでした（${rankResult.missingAxes.map((a) => a.label).join("・")}）。`
      : shippingRank === "OVERSIZE"
        ? "3辺合計が家財おまかせ便のランク表の範囲外（451cm〜）のため、個別見積りが必要です。"
        : null;

  const sagawa = resolveSagawaSize({
    width: input.width,
    depth: input.depth,
    height: input.height,
    weightKg: input.weightKg ?? null,
  });

  const warnings: string[] = [];
  if (!input.width?.trim() || !input.depth?.trim() || !input.height?.trim()) {
    warnings.push("⚠ 幅・奥行・高さのいずれかが登録されていません。");
  }
  if (!seat.hasAny) {
    // 座面が無い商品(テーブル・照明)では正常なので、警告の文言を断定しない。
    warnings.push("⚠ 座面寸法が登録されていません（座面のある商品の場合はZAICOをご確認ください）。");
  } else if (!seat.hasAll) {
    warnings.push(
      `⚠ 座面寸法の一部だけが登録されています（${[seat.width ? null : "幅", seat.depth ? null : "奥行", seat.height ? null : "高さ"]
        .filter(Boolean)
        .join("・")}が不明）。`,
    );
  }
  if (shippingRankReason) warnings.push(`⚠ 配送ランクを確定できません：${shippingRankReason}`);
  if (sagawa.unavailableReason) warnings.push(`⚠ 佐川急便のサイズを判定できません：${sagawa.note}`);
  if (!material) warnings.push("⚠ 材質が登録されていません。");
  if (!maintenance.hasAny) warnings.push("⚠ メンテナンスの記録が見つかりませんでした。");

  return {
    safe: facts,
    redactions,
    brand: input.brand?.trim() || null,
    material,
    width: input.width?.trim() || null,
    depth: input.depth?.trim() || null,
    height: input.height?.trim() || null,
    overallLength: input.overallLength?.trim() || null,
    seat,
    maintenance,
    nonFabric,
    shippingRank,
    shippingRankReason,
    shippingSumCm,
    sagawa,
    goodConditionEvidence: hasGoodConditionEvidence(input.conditionRating),
    warnings,
  };
}
