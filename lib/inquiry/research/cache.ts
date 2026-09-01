/**
 * §20 外部リサーチ結果のキャッシュ方針。純粋関数のみ(DB操作はservice.ts)。
 *
 * 変動する情報を長く持たない。公式仕様・寸法・素材は年単位で変わらない
 * ため長め、価格・在庫は短め。TTLをfieldの種類から決めるのは、キャッシュ
 * 行そのものに有効期限を焼き込まないため —— 方針を変えたときに既存行を
 * 書き換えずに済む。
 */

/** 変動しやすい項目。短いTTL。 */
const VOLATILE_FIELD_PATTERNS = [/価格/, /値段/, /在庫/, /price/i, /stock/i, /セール/, /キャンペーン/];

/** 公式仕様として安定している項目。長いTTL。 */
const STABLE_FIELD_PATTERNS = [/寸法/, /サイズ/, /素材/, /材質/, /耐荷重/, /重量/, /仕様/, /型番/, /生産国/, /dimension/i, /material/i];

export const RESEARCH_TTL_VOLATILE_MS = 6 * 60 * 60 * 1000; // 6時間
export const RESEARCH_TTL_STABLE_MS = 90 * 24 * 60 * 60 * 1000; // 90日
export const RESEARCH_TTL_DEFAULT_MS = 7 * 24 * 60 * 60 * 1000; // 7日

export function researchTtlMs(field: string): number {
  if (VOLATILE_FIELD_PATTERNS.some((re) => re.test(field))) return RESEARCH_TTL_VOLATILE_MS;
  if (STABLE_FIELD_PATTERNS.some((re) => re.test(field))) return RESEARCH_TTL_STABLE_MS;
  return RESEARCH_TTL_DEFAULT_MS;
}

/**
 * キャッシュキー。
 *
 * 「どの商品の」「どの項目か」で決まる決定的な文字列。商品識別子には
 * 在庫IDを使う —— 商品名を使うと、名前を編集しただけでキャッシュが
 * 全部外れる。在庫が特定できていない場合は、検索語そのものから作る。
 */
export function buildResearchCacheKey(params: { inventoryId: string | null; field: string; queryText: string }): string {
  const subject = params.inventoryId ? `inv:${params.inventoryId}` : `q:${normalize(params.queryText)}`;
  return `${subject}|${normalize(params.field)}`;
}

export function isResearchCacheFresh(fetchedAtIso: string, field: string, now = Date.now()): boolean {
  const fetchedAt = Date.parse(fetchedAtIso);
  if (Number.isNaN(fetchedAt)) return false;
  return now - fetchedAt < researchTtlMs(field);
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 120);
}
