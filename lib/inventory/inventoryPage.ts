import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { toListRow, type InventoryListRow } from "./queries";
import { isE2EFixtureModeActive, e2eListPage } from "./e2eFixtures";
import type { InventoryCursorListFilters } from "./inventoryCursorList";

/**
 * 在庫一覧の取得を「必要なページだけ」にする。
 *
 * ## なぜ作ったか（実測）
 *
 * Staging実機で `/inventory` のTTFBが **約8秒**だった。合計8.2秒の
 * うち8.1秒がサーバー側。原因は lib/inventory/queries.ts の
 * `fetchAllInventoryRecords` で、1ページ200件のlistをnextTokenが
 * 尽きるまで回して**5,313件すべて**を読み、そこから50件をsliceして
 * いたこと。27往復ぶんの待ち時間を、50件表示するために毎回払っていた。
 *
 * 同じ画面の他の取得（カテゴリ/保管場所/状態/追加項目の4マスタ）は、
 * 同じ4つを取っている設定画面のTTFBが150msだったことから、合計でも
 * 150ms程度。つまり一覧の遅さはほぼ全部この全件取得だった。
 *
 * ## どう変えたか
 *
 * `listingPartition="ACTIVE"` を固定パーティションキーとするGSIへの
 * **本物のQuery**（Scanではない）を、表示するページに到達するまでだけ
 * 進める。1ページ目なら1往復。offsetが進んでも、その位置までの
 * ページ数ぶんで済み、テーブル全体には比例しない。
 *
 * GSIのバックフィルは完了済み（実測: listingPartitionを持つ行が
 * 5,313 / 全5,313）。未バックフィルの行があるとGSIに現れないため、
 * この関数は「取得できた件数が0で、かつ1ページ目」の場合に呼び出し側が
 * 従来経路へ切り替えられるよう、`usedIndex` を返す。
 *
 * ## 総件数について
 *
 * 総件数は本質的に全件読まないと出せない。ここでは行の取得と分離し、
 * 呼び出し側がSuspenseで後から流し込めるようにしてある（
 * countActiveInventory）。行の表示は総件数を待たない。
 */

/** DynamoDBの1ページは1MBで頭打ちになる。件数だけ増やしても往復は減らない。 */
const QUERY_PAGE_SIZE = 100;
/** 件数集計で1往復あたりに要求する件数。1MB制限に当たるまでは大きいほど往復が減る。 */
const COUNT_PAGE_SIZE = 1000;
/** 安全弁。想定を超える規模になったら打ち切る（lib/inventory/queries.tsのSEARCH_MAX_SCAN_ITEMSと同じ考え方）。 */
const MAX_PAGES = 60;

function buildFilter(filters: InventoryCursorListFilters): Record<string, unknown> {
  const conditions: Record<string, unknown>[] = [{ deletedAt: { attributeExists: false } }];
  if (filters.categoryIds && filters.categoryIds.length > 0) {
    conditions.push({ or: filters.categoryIds.map((id) => ({ categoryId: { eq: id } })) });
  }
  if (filters.locationId) conditions.push({ locationId: { eq: filters.locationId } });
  if (filters.statusId) conditions.push({ statusId: { eq: filters.statusId } });
  return { and: conditions };
}

export interface InventoryOffsetPage {
  items: InventoryListRow[];
  offset: number;
  limit: number;
  /** 次のページがあるか。総件数を知らなくても分かる（nextTokenの有無）。 */
  hasNext: boolean;
  /** GSI経由で取得できたか。falseなら呼び出し側は従来経路へ落とす。 */
  usedIndex: boolean;
}

/**
 * offset/limit のURL契約はそのままに、GSIのQueryで必要な位置まで進める。
 *
 * URLの形（?offset=50&limit=50）を変えないのは、既存のページネーション
 * リンク・E2E・ブラウザ履歴をそのまま動かすため。カーソルをURLへ載せる
 * 設計は「戻る」や共有リンクの互換性を壊す。
 */
export async function listInventoryOffsetPage(
  filters: InventoryCursorListFilters,
  options: { offset: number; limit: number },
): Promise<InventoryOffsetPage> {
  if (isE2EFixtureModeActive()) {
    const page = e2eListPage(options.offset, options.limit);
    return { items: page.items, offset: page.offset, limit: page.limit, hasNext: page.offset + page.limit < page.total, usedIndex: true };
  }

  const filter = buildFilter(filters);
  const needed = options.offset + options.limit;
  const collected: InventoryListRow[] = [];
  let nextToken: string | null | undefined;
  let pages = 0;

  do {
    const { data, nextToken: nt, errors } = await serverDataClient.models.Inventory.listInventoryByListingPartitionAndListUpdatedAt(
      { listingPartition: "ACTIVE" },
      {
        sortDirection: "DESC", // listUpdatedAt降順 = 既存の updatedAt DESC と同じ意図
        filter,
        limit: QUERY_PAGE_SIZE,
        nextToken: nextToken ?? undefined,
        ...inventoryAuthMode,
      },
    );
    // §13.2: errorsを無視して空配列にしない。取得エラーと0件は別物。
    if (errors) throw new Error(`在庫データの取得に失敗しました: ${errors.map((e) => e.message).join("; ")}`);
    collected.push(...data.map(toListRow));
    nextToken = nt;
    pages++;
  } while (nextToken && collected.length < needed && pages < MAX_PAGES);

  // GSIに1件も出てこない = バックフィル未完了の可能性。呼び出し側で
  // 従来経路へ落とせるようにする（黙って「0件」と表示しない）。
  if (collected.length === 0 && options.offset === 0 && !nextToken) {
    return { items: [], offset: options.offset, limit: options.limit, hasNext: false, usedIndex: false };
  }

  const items = collected.slice(options.offset, options.offset + options.limit);
  return {
    items,
    offset: options.offset,
    limit: options.limit,
    // 取り切れていない（まだnextTokenがある）か、今回集めた中に次ページ分が残っているか。
    hasNext: Boolean(nextToken) || collected.length > options.offset + options.limit,
    usedIndex: true,
  };
}

/**
 * 総件数。
 *
 * 表示専用なので、行の取得とは切り離してSuspenseで後から流す。
 * 同じ条件の集計はプロセス内で短時間だけ使い回す —— 在庫は編集される
 * ので長く持たない。60秒なら、同じ画面を続けて開き直しても1回で済み、
 * かつ「登録したのに件数が増えない」が長く続くことはない。
 */
const COUNT_TTL_MS = 60_000;
const countCache = new Map<string, { at: number; value: number }>();

export function inventoryCountCacheKey(filters: InventoryCursorListFilters): string {
  return JSON.stringify({
    c: [...(filters.categoryIds ?? [])].sort(),
    l: filters.locationId ?? null,
    s: filters.statusId ?? null,
  });
}

/** 在庫を書き換えたあとに呼ぶ。古い件数を表示し続けないため。 */
export function clearInventoryCountCache(): void {
  countCache.clear();
}

export async function countActiveInventory(filters: InventoryCursorListFilters): Promise<number> {
  const key = inventoryCountCacheKey(filters);
  const hit = countCache.get(key);
  if (hit && Date.now() - hit.at < COUNT_TTL_MS) return hit.value;

  const filter = buildFilter(filters);
  let total = 0;
  let nextToken: string | null | undefined;
  let pages = 0;
  do {
    const { data, nextToken: nt, errors } = await serverDataClient.models.Inventory.listInventoryByListingPartitionAndListUpdatedAt(
      { listingPartition: "ACTIVE" },
      {
        filter,
        limit: COUNT_PAGE_SIZE,
        nextToken: nextToken ?? undefined,
        // 件数だけが要るので、返す項目はidに絞る。DynamoDBの1MB制限は
        // 読み取り側で効くため往復数が劇的に減るとは限らないが、
        // 転送量とJSONのパース時間は確実に減る。
        selectionSet: ["id"],
        ...inventoryAuthMode,
      },
    );
    if (errors) throw new Error(`件数の集計に失敗しました: ${errors.map((e) => e.message).join("; ")}`);
    total += data.length;
    nextToken = nt;
    pages++;
  } while (nextToken && pages < MAX_PAGES);

  countCache.set(key, { at: Date.now(), value: total });
  return total;
}
