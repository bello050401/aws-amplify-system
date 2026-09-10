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
import { requiresSeatDimensions, resolveSeatDimensions, type SeatDimensions } from "@/lib/inventory/seatDimensions";
import { calculateShippingRankFromDimensionsDetailed, type ShippingRank } from "@/lib/shipping/rank";
import { KAZAI_SERVICE_NAME } from "@/lib/shipping/serviceName";
import { resolveSagawaSize, type SagawaSizeResult, type SagawaUnavailableReason } from "@/lib/shipping/sagawaSize";
import { DEFAULT_LISTING_SHIPPING_METHOD, type ListingShippingMethod } from "@/lib/listing/types";

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
  /**
   * 担当者が選択中の配送方法(2026-09-10追加指示)。
   *
   * 警告の適用条件だけに使う —— らくらく家財便のランクと佐川サイズは
   * どちらも常に確定させる(表示・監査用に両方欲しい呼び出し元がいる)。
   * 「確定できません」の警告だけを、選択中の方法に合わせて出し分ける。
   * 未指定なら既定(らくらく家財便)として扱う。
   */
  shippingMethod?: ListingShippingMethod;
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
  /** らくらく家財便のランク。判定できなければ null(§10)。 */
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

/**
 * 配送警告のメッセージの先頭部分。クライアント側(ListingForm.tsx)が
 * 「配送方法だけを生成後に切り替えた」ときに、古い方の警告を判別して
 * 差し替えるためのプレフィックスとして共有する(下の関数群を参照)。
 */
export const SAGAWA_UNAVAILABLE_WARNING_PREFIX = "⚠ 佐川急便のサイズを判定できません";
export const KAZAI_RANK_UNAVAILABLE_WARNING_PREFIX = "⚠ 配送ランクを確定できません";

/**
 * 配送の警告(担当者が選んでいる方法にだけ出す)を1つ組み立てる共通関数
 * (2026-09-10追加指示・レビュー対応)。
 *
 * buildListingFacts(生成時点)と ListingForm.tsx(生成後に画面の配送方法
 * だけを切り替えたとき)の両方から呼ぶ。ここを2箇所に別々に書くと、
 * 生成直後の警告と、切り替え後にクライアントが作り直す警告の文言が
 * ずれる恐れがある。
 */
export function buildShippingWarning(input: {
  shippingMethod: ListingShippingMethod;
  sagawaUnavailableReason: SagawaUnavailableReason | null;
  sagawaNote: string;
  shippingRankReason: string | null;
}): string | null {
  if (input.shippingMethod === "SAGAWA") {
    return input.sagawaUnavailableReason ? `${SAGAWA_UNAVAILABLE_WARNING_PREFIX}：${input.sagawaNote}` : null;
  }
  return input.shippingRankReason ? `${KAZAI_RANK_UNAVAILABLE_WARNING_PREFIX}：${input.shippingRankReason}` : null;
}

/**
 * 生成時に確定した警告一覧のうち、配送警告だけを現在選択中の配送方法
 * 向けへ差し替える。座面寸法・メンテナンス等、配送方法に関係ない警告は
 * そのまま残す(§21 警告を手抜きで全部消さない)。
 *
 * 生成ボタンを押した後に画面の配送方法だけを切り替えても、
 * サーバーへ再度問い合わせずにこの関数で警告を作り直せる —— 元の
 * 配送警告(例:「らくらく家財便」選択時に出た「配送ランクを確定できま
 * せん」)を、選んでいない方法の警告として残さない。
 */
export function withCurrentShippingWarning(warnings: string[], currentShippingWarning: string | null): string[] {
  const rest = warnings.filter(
    (w) => !w.startsWith(SAGAWA_UNAVAILABLE_WARNING_PREFIX) && !w.startsWith(KAZAI_RANK_UNAVAILABLE_WARNING_PREFIX),
  );
  return currentShippingWarning ? [...rest, currentShippingWarning] : rest;
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

  // ── らくらく家財便のランク(§8 既存ロジックを再利用) ────────────
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
        ? `3辺合計が${KAZAI_SERVICE_NAME}のランク表の範囲外（451cm〜）のため、個別見積りが必要です。`
        : null;

  // 追加指示 §2 重量は見ない。3辺合計 + 20cm だけで確定させる。
  const sagawa = resolveSagawaSize({ width: input.width, depth: input.depth, height: input.height });

  const shippingMethod = input.shippingMethod ?? DEFAULT_LISTING_SHIPPING_METHOD;

  const warnings: string[] = [];
  if (!input.width?.trim() || !input.depth?.trim() || !input.height?.trim()) {
    warnings.push("⚠ 幅・奥行・高さのいずれかが登録されていません。");
  }
  // 座面寸法の警告は、座面のある商品(チェア・ソファ・スツール等)に限る
  // (2026-09-10追加指示)。机・テーブル・照明では座面自体が無いのが正常
  // で、無条件に警告すると実際に無関係な商品にまで出てしまっていた。
  if (requiresSeatDimensions({ categoryName: input.categoryName, name: input.name })) {
    if (!seat.hasAny) {
      warnings.push("⚠ 座面寸法が登録されていません（ZAICOをご確認ください）。");
    } else if (!seat.hasAll) {
      warnings.push(
        `⚠ 座面寸法の一部だけが登録されています（${[seat.width ? null : "幅", seat.depth ? null : "奥行", seat.height ? null : "高さ"]
          .filter(Boolean)
          .join("・")}が不明）。`,
      );
    }
  }
  // 配送の警告も、担当者が選んでいる方法にだけ出す(2026-09-10追加指示)。
  // 佐川を選んでいないのに「佐川のサイズを判定できません」と出ると、
  // 実際には使わない配送方法の警告に気を取られる。ランク・サイズ自体は
  // どちらも上で確定済みなので、選択を切り替えれば警告も即座に変わる。
  const shippingWarning = buildShippingWarning({
    shippingMethod,
    sagawaUnavailableReason: sagawa.unavailableReason,
    sagawaNote: sagawa.note,
    shippingRankReason,
  });
  if (shippingWarning) warnings.push(shippingWarning);
  // 材質未登録・不明は警告にしない(2026-09-10追加指示)。値・事実として
  // は残す(material フィールドはそのまま null/文字列を返す)が、生成を
  // 妨げるほどの不足ではないので担当者への警告からは外す。
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
