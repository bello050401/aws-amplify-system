import "server-only";

/**
 * マスタ(カテゴリー/保管場所/在庫ステータス/追加項目定義)の
 * リクエストを跨いだキャッシュ(2026-09-04 性能総点検)。
 *
 * ── なぜ要るのか(実測) ──────────────────────────────────────────
 *
 * この4つは**ほぼ全ての画面**が描画のたびに読む(在庫一覧・商品詳細・
 * 編集・新規登録・EC出品・設定)。既存の `requestCache` は React の
 * cache() で、効くのは**1リクエストの中だけ**。画面を移動するたびに
 * 4回のAppSync往復が必ず発生していた。
 *
 * 中身は Staging 実測で
 *
 *   Category 20件 / Location 13件 / StatusMaster 0件 / CustomFieldDefinition 12件
 *
 * しかなく、変更は設定画面からの明示的な操作だけ。毎回取りに行く理由が無い。
 *
 * ── 古いデータを見せないための設計(§9) ──────────────────────────
 *
 * 「速く見せるために古い値を出す」ことは禁止されている。そこで
 *
 *   1. **書き込み側が必ず捨てる。** マスタを変更する経路(app/actions/
 *      masters.ts / customFields.ts / lib/inventory/masterSeed.ts など)は
 *      revalidatePath と同じ場所で invalidateMasterCache() を呼ぶ。
 *      呼び忘れを防ぐため、書き込み関数の側(lib/inventory/masters.ts,
 *      customFields.ts)に置いてある —— Server Action を1つ足した人が
 *      気づかなくても効く。
 *   2. **TTLも併用する。** 別のプロセス(別のLambdaインスタンス)が行った
 *      変更は、こちらのプロセスの invalidate では消えない。SSRは複数
 *      インスタンスで動くので、これが実際に起きる。TTLを短く置いて、
 *      最悪でもその時間で追いつくようにする。
 *
 * 60秒にしたのは、
 *   ・マスタの編集は設定画面での操作で、直後に同じ画面を見る人は
 *     invalidate 済みのプロセスに当たる可能性が高い
 *   ・別インスタンスに当たっても1分で揃う
 *   ・在庫の商品名照合(lib/inquiry/productResolver.ts)が同じ理由で
 *     60秒を選んでおり、この repo の中で判断を揃えられる
 * ため。
 */

/** キャッシュの寿命。別インスタンスの変更に追いつくまでの上限でもある。 */
export const MASTER_CACHE_TTL_MS = 60_000;

interface Entry<T> {
  at: number;
  value: T;
}

const store = new Map<string, Entry<unknown>>();

/**
 * キャッシュ越しに読む。**取得に失敗したら何も残さない** ——
 * 失敗をキャッシュすると、一度の瞬断が60秒間続く障害に化ける。
 */
export async function cachedMaster<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && Date.now() - hit.at < MASTER_CACHE_TTL_MS) return hit.value;
  const value = await load();
  store.set(key, { at: Date.now(), value });
  return value;
}

/**
 * マスタを変更したときに呼ぶ。
 *
 * 引数を取らないのは意図的。カテゴリーを変えたときに「カテゴリーだけ」を
 * 捨てる細かさは、呼び忘れの危険に見合わない。4つとも小さいので、
 * まとめて捨てて次のリクエストで取り直すほうが安全で速い。
 */
export function invalidateMasterCache(): void {
  store.clear();
}

/** テスト・診断用。いま何が乗っているか。 */
export function masterCacheKeys(): string[] {
  return [...store.keys()];
}
