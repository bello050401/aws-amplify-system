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
  /** 在庫数。同一商品をまとめたときの内訳表示に使う。 */
  quantity?: number | null;
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
  /**
   * URLから**IDで確定的に**引き当てたBASE過去商品の商品名。
   *
   * 顧客が本文へ書いた語(nameFragments)とは性質がまったく違う。
   * こちらは「このBASE商品ページの正式なタイトル」で、BELLOが自分の
   * 在庫名から起こしたものなので、在庫名との一致は同一性の強い証拠に
   * なる。実データで確認した例:
   *
   *   BASE 155832757 : "HAY REVOLVER BAR STOOL HIGH / デンマーク 北欧 …"
   *   Inventory B005611: "【在庫2】HAY REVOLVER BAR STOOL HIGH / デンマーク 北欧 …"
   *   Inventory B005610: "【在庫2】HAY REVOLVER BAR STOOL HIGH / 北欧 デンマーク …"
   *
   * 語の集合はほぼ同じで、**語順だけ**が違う。ブランド+語の断片という
   * 弱い手がかりの積み上げ(合計0.52)では候補の下限0.60にすら届かず、
   * 「候補0件」になっていた —— 正しい在庫が目の前にあるのに。
   */
  baseTitles?: string[];
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
 * BASE商品名との一致の配点。
 *
 * 完全一致(正規化後)は同一性を保証する扱いにする —— BASEの商品ページは
 * BELLOが自分の在庫名から起こしているため。同名の在庫が2件あれば両方が
 * 同点になるが、それは mergeSameProduct が**1件へまとめてから**
 * decideResolution へ渡す。BELLOは同じ商品を傷の有無や在庫数で行に
 * 分けており(「【小傷あり】…」「【在庫2】…」)、これは候補が割れたので
 * はなく同じ商品なので、人の確認を待たせる理由が無い
 * (2026-09-03 利用者指示)。
 *
 * **芯が違う商品どうしは今も同点のまま AMBIGUOUS になる。**
 * まとめるのは「先頭の【】を落とすと同じ文字列になるもの」だけ。
 */
const SCORE_BASE_TITLE_EXACT = 0.96;
const SCORE_BASE_TITLE_NEAR = 0.85;
const SCORE_BASE_TITLE_PARTIAL = 0.7;
const BASE_TITLE_NEAR_THRESHOLD = 0.85;
const BASE_TITLE_PARTIAL_THRESHOLD = 0.6;

/**
 * 商品名を比較できる形へ。
 *
 * 在庫名の先頭にある【在庫2】【6/30指定】のような社内マーカーはBASEの
 * 商品ページには載らないので落とす。末尾の検索用キーワードも同様
 * (nameCoreと同じ理由)。記号・空白の差は同一性に関係しないので畳む。
 */
export function normalizeProductTitle(name: string): string {
  return nameCore(name)
    .normalize("NFKC")
    .replace(/【[^】]*】/g, " ")
    .replace(/[（）()［］\[\]{}「」『』/／・,、。]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/** 語の集合の重なり(Jaccard)。語順の違いを同一性の差として扱わないため。 */
function titleOverlap(a: string, b: string): number {
  const sa = new Set(a.split(" ").filter((t) => t.length > 0));
  const sb = new Set(b.split(" ").filter((t) => t.length > 0));
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const t of sa) if (sb.has(t)) shared++;
  return shared / (sa.size + sb.size - shared);
}

/**
 * 商品名の「検索用キーワード」部分を切り落とす。
 *
 * 実在庫の商品名は、末尾へ検索用の関連ワードを並べる運用になっている:
 *
 *   PIIROINEN A-Frame sofa 2人掛け ソファ … 検:アルフレックス カッシーナ ボーコンセプト
 *
 * ここに入るのは**他社ブランド名**なので、そのまま照合すると
 * 「カッシーナのソファについて」という問い合わせが、カッシーナ製ではない
 * この商品にヒットする。関連ワードは商品の同一性を示さない。
 *
 * 【実測】Staging在庫400件のうち172件(43%)が `検:` を使っていた。
 * `他:` は0件 —— 当初 `他:` だけを見ていたが、実データでは一度も
 * 使われていない書き方だった。両方を見る。
 */
const KEYWORD_TAIL = /(?:検索|検|他)\s*[:：]/;

export function nameCore(name: string): string {
  const match = name.match(KEYWORD_TAIL);
  return match?.index !== undefined ? name.slice(0, match.index) : name;
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

  // ── BASE商品名との一致(URLからIDで確定的に引いたタイトル) ────
  if (signals.baseTitles && signals.baseTitles.length > 0) {
    const invTitle = normalizeProductTitle(inv.name);
    let best = 0;
    let bestReason = "";
    for (const raw of signals.baseTitles) {
      const baseTitle = normalizeProductTitle(raw);
      if (!baseTitle || !invTitle) continue;
      if (baseTitle === invTitle) {
        if (SCORE_BASE_TITLE_EXACT > best) { best = SCORE_BASE_TITLE_EXACT; bestReason = "BASE商品ページの商品名と完全に一致"; }
        continue;
      }
      const overlap = titleOverlap(baseTitle, invTitle);
      if (overlap >= BASE_TITLE_NEAR_THRESHOLD && SCORE_BASE_TITLE_NEAR > best) {
        best = SCORE_BASE_TITLE_NEAR;
        bestReason = `BASE商品ページの商品名とほぼ一致(語の重なり ${(overlap * 100).toFixed(0)}%)`;
      } else if (overlap >= BASE_TITLE_PARTIAL_THRESHOLD && SCORE_BASE_TITLE_PARTIAL > best) {
        best = SCORE_BASE_TITLE_PARTIAL;
        bestReason = `BASE商品ページの商品名と部分的に一致(語の重なり ${(overlap * 100).toFixed(0)}%)`;
      }
    }
    if (best > 0) {
      strong = Math.max(strong, best);
      reasons.push(bestReason);
    }
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

/**
 * 商品名から、在庫行ごとの注記(【小傷あり】【在庫2】など)を落とした「商品の芯」。
 *
 * BELLOは同じ商品を状態や在庫数で行に分けており、その違いは名前の先頭の
 * 【】に入る。ここを落とすと同じ文字列になるものは、同じ商品と見てよい
 * (2026-09-03 利用者指示)。
 */
export function productIdentityKey(name: string): string {
  return name
    // 先頭に連続する【…】をすべて落とす。途中の【】は商品名の一部で
    // ありうるので触らない。
    .replace(/^(?:\s*【[^】]*】)+/u, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * 同一商品として扱える候補をまとめる。
 *
 * **候補が割れているのか、同じ商品が行に分かれているだけなのかは別物。**
 * 前者は人が判断する必要があるが、後者は自動で答えてよい。実機で
 * 「【小傷あり】BoConcept Elba…」と「【在庫2】BoConcept Elba…」が
 * 0.96で並び、同じ商品なのに AMBIGUOUS になっていた。
 *
 * まとめた行の内訳は mergedRows に残す —— 担当者は「どの行が何点か」で
 * 出荷を判断するので、ここを捨てると使えない通知になる。
 */
export function mergeSameProduct(scored: ProductMatch[]): ProductMatch[] {
  const groups = new Map<string, ProductMatch[]>();
  for (const m of scored) {
    const key = productIdentityKey(m.name);
    // 芯が空になる名前(【】だけ等)は統合しない。別物を巻き込みかねない。
    const bucket = key ? key : `__unique__:${m.inventoryId}`;
    const list = groups.get(bucket);
    if (list) list.push(m);
    else groups.set(bucket, [m]);
  }

  const merged: ProductMatch[] = [];
  for (const list of groups.values()) {
    if (list.length === 1) {
      merged.push(list[0]);
      continue;
    }
    // 代表は確信度が最も高い行。同点なら在庫IDで安定させる(実行ごとに
    // 代表が入れ替わると、通知の内容が理由なく変わる)。
    const sorted = [...list].sort(
      (a, b) => b.confidence - a.confidence || a.inventoryId.localeCompare(b.inventoryId),
    );
    const head = sorted[0];
    merged.push({
      ...head,
      // 統合したことを理由にも残す。担当者が「なぜ1件になったか」を追える。
      reasons: [...head.reasons, `同一商品の在庫${sorted.length}行を1件にまとめました`],
      mergedRows: sorted.map((m) => ({
        displayInventoryId: m.displayInventoryId,
        name: m.name,
        quantity: m.quantity ?? null,
      })),
    });
  }
  return merged;
}

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
