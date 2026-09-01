/**
 * §4.2/§4.3/§37 商品候補のスコアリング。純粋関数のみ —— DBに触れないので
 * scripts/verify-inquiry.tsから直接テストできる。
 *
 * 【この設計で一番避けたい事故】家具は同シリーズ・色違い・サイズ違いが
 * 多い。「ソファ」という語だけで在庫の別商品を確定させると、顧客には
 * 全く違う商品の寸法が案内される。返信は人が最終確認するとはいえ、
 * 画面に「対象商品: ○○(確定)」と出ていれば人もそれを疑わない。
 *
 * そこで、**同一性を保証する一致**(URL・BASE商品ID・SKU・在庫ID)と、
 * **同一性を保証しない一致**(ブランド・商品名の部分一致)をはっきり
 * 分ける。後者だけをいくら積み上げても自動確定の閾値(0.95)へは
 * 届かないように上限を設ける。
 */
import type { ProductMatch, ProductResolution } from "./types";
import { PRODUCT_MATCH_AUTO_CONFIRM, PRODUCT_MATCH_CANDIDATE_FLOOR } from "./types";

/** 照合対象として渡す在庫1件分の情報(必要な項目だけ)。 */
export interface MatchableInventory {
  id: string;
  displayInventoryId: string;
  sku: string;
  name: string;
  /** 販売先サイト上の商品ID(Inventory.externalProductId)。 */
  externalProductId: string | null;
  barcode: string | null;
  sourceInventoryId: string | null;
  /** ChannelListingから引いた、この在庫の外部出品情報。 */
  listings: { channel: string; externalListingId: string | null; listingUrl: string | null }[];
}

/** 照合に使う手がかり(references.tsの出力を正規化したもの)。 */
export interface MatchSignals {
  normalizedUrls: string[];
  baseItemIds: string[];
  skus: string[];
  inventoryIds: string[];
  modelNumbers: string[];
  brandNames: string[];
  nameFragments: string[];
}

/**
 * 同一性を保証する一致の配点。1つでも当たれば自動確定の水準に達する。
 * §4.2の照合優先順位(在庫ID > SKU > BASE Item ID > BASE URL > 型番 …)を
 * そのまま点数の高さで表現する。
 */
const SCORE_URL_EXACT = 0.98;
const SCORE_BASE_ITEM_ID = 0.97;
const SCORE_SKU = 0.99;
const SCORE_INVENTORY_ID = 0.99;
const SCORE_EXTERNAL_PRODUCT_ID = 0.96;
const SCORE_BARCODE = 0.96;

/**
 * 同一性を保証しない一致の配点と、その合計の上限。
 *
 * 上限を PRODUCT_MATCH_AUTO_CONFIRM 未満に置くのがこのファイルの肝。
 * 型番はかなり強い手がかりだが、同じ型番で年式・色違いが在庫に複数ある
 * 可能性があるため、単独では確定させない(§38と同じ考え方)。
 */
const SCORE_MODEL_NUMBER = 0.55;
const SCORE_BRAND = 0.2;
const SCORE_NAME_FRAGMENT = 0.08;
const SCORE_NAME_FRAGMENT_MAX = 0.32;
export const WEAK_SIGNAL_SCORE_CAP = 0.92;

/**
 * 商品名の「他:」以降を切り落とす。
 *
 * 実在庫の商品名は `… ブラック 他:フランス アルテミデ ヤマギワ` のように、
 * 末尾へ検索用の関連ワードを並べる運用になっている。ここに他社ブランド名が
 * 入るため、そのまま照合すると「ヤマギワ」の問い合わせが別メーカーの
 * 商品にヒットする。関連ワードは商品の同一性を示さないので、
 * ブランド・型番の照合からは外す。
 */
export function nameCore(name: string): string {
  const idx = name.search(/他\s*[:：]/);
  return idx >= 0 ? name.slice(0, idx) : name;
}

export function scoreInventory(inv: MatchableInventory, signals: MatchSignals): { confidence: number; reasons: string[] } {
  const reasons: string[] = [];
  let strong = 0;

  if (signals.skus.length > 0 && signals.skus.includes(inv.sku.toUpperCase())) {
    strong = Math.max(strong, SCORE_SKU);
    reasons.push(`SKU(${inv.sku})が一致`);
  }
  if (signals.inventoryIds.length > 0) {
    const displayId = inv.displayInventoryId;
    if (signals.inventoryIds.includes(displayId) || (inv.sourceInventoryId && signals.inventoryIds.includes(inv.sourceInventoryId))) {
      strong = Math.max(strong, SCORE_INVENTORY_ID);
      reasons.push(`在庫ID(${displayId})が一致`);
    }
  }
  if (signals.baseItemIds.length > 0) {
    const listingIds = inv.listings.filter((l) => l.channel === "BASE").map((l) => l.externalListingId);
    if (listingIds.some((id) => id && signals.baseItemIds.includes(id))) {
      strong = Math.max(strong, SCORE_BASE_ITEM_ID);
      reasons.push("BASEの商品IDが一致");
    }
  }
  if (signals.normalizedUrls.length > 0) {
    const urls = inv.listings.map((l) => l.listingUrl).filter((u): u is string => Boolean(u));
    if (urls.some((u) => signals.normalizedUrls.includes(u))) {
      strong = Math.max(strong, SCORE_URL_EXACT);
      reasons.push("出品URLが一致");
    }
  }
  if (inv.externalProductId && signals.baseItemIds.includes(inv.externalProductId)) {
    strong = Math.max(strong, SCORE_EXTERNAL_PRODUCT_ID);
    reasons.push("販売先サイトの商品IDが一致");
  }
  if (inv.barcode && signals.inventoryIds.includes(inv.barcode)) {
    strong = Math.max(strong, SCORE_BARCODE);
    reasons.push("バーコードが一致");
  }

  // ── 同一性を保証しない手がかり ────────────────────────────────
  const core = nameCore(inv.name);
  const coreUpper = core.toUpperCase();
  let weak = 0;

  const matchedModels = signals.modelNumbers.filter((m) => coreUpper.includes(m));
  if (matchedModels.length > 0) {
    weak += SCORE_MODEL_NUMBER;
    reasons.push(`型番らしき文字列が商品名に含まれる(${matchedModels.join(", ")})`);
  }
  const matchedBrands = signals.brandNames.filter((b) => core.toUpperCase().includes(b.toUpperCase()));
  if (matchedBrands.length > 0) {
    weak += SCORE_BRAND;
    reasons.push(`ブランド名が商品名に含まれる(${matchedBrands.join(", ")})`);
  }
  const matchedFragments = signals.nameFragments.filter((f) => f.length >= 2 && coreUpper.includes(f.toUpperCase()));
  if (matchedFragments.length > 0) {
    weak += Math.min(SCORE_NAME_FRAGMENT_MAX, matchedFragments.length * SCORE_NAME_FRAGMENT);
    reasons.push(`商品名の語が一致(${matchedFragments.slice(0, 5).join(", ")})`);
  }
  weak = Math.min(weak, WEAK_SIGNAL_SCORE_CAP);

  return { confidence: Math.max(strong, weak), reasons };
}

/**
 * スコア済み候補から結論を出す。
 *
 * 【1位が高得点でも確定させない場合がある】同点に近い2位がいるときは
 * 確定させない(§4.3「同程度の候補が複数ある場合は勝手に決めない」)。
 * 色違い・サイズ違いはまさにこの形で現れる —— 商品名がほぼ同じなので
 * スコアもほぼ同じになる。
 */
export const AMBIGUITY_MARGIN = 0.05;

export function decideResolution(scored: ProductMatch[]): ProductResolution {
  const sorted = [...scored].sort((a, b) => b.confidence - a.confidence || a.inventoryId.localeCompare(b.inventoryId));
  const candidates = sorted.filter((c) => c.confidence >= PRODUCT_MATCH_CANDIDATE_FLOOR).slice(0, 5);

  if (candidates.length === 0) return { status: "NOT_FOUND", resolved: null, candidates: [] };

  const top = candidates[0];
  const second = candidates[1];
  const clearlyAhead = !second || top.confidence - second.confidence >= AMBIGUITY_MARGIN;

  if (top.confidence >= PRODUCT_MATCH_AUTO_CONFIRM && clearlyAhead) {
    return { status: "RESOLVED", resolved: top, candidates };
  }
  return { status: "AMBIGUOUS", resolved: null, candidates };
}
