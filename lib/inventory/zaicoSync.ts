import "server-only";
import { getInventory, listInventories } from "@/lib/zaico/client";
import { getServerSyncPort, type ZaicoSyncPort, type MasterCache } from "./zaicoSyncPorts";
import { syncOneZaicoItem, type ZaicoSyncItemResult } from "./zaicoSyncEngine";

/**
 * The ZAICO→BELLO one-way sync engine's Next.js entry points
 * (implementation instructions §1-39). This file does NOT call ZAICO
 * write endpoints (lib/zaico/client.ts has none to call) and does NOT
 * call the existing createInventory/updateInventory Server Actions from
 * app/actions/inventory.ts — those `redirect()` on success, which is
 * correct for a browser form submit and wrong for a batch loop that
 * needs to keep going across many items.
 *
 * BELLO統合業務OS 第五ラウンド §4(P0-A): `syncOneZaicoItem`とその純粋
 * ヘルパーは`./zaicoSyncEngine`(server-onlyを持たない、Lambdaへ
 * bundle可能なファイル)へ移動した——`amplify/functions/
 * zaico-sync-worker/`がこの同じ関数を、Lambda側の生AWS SDK実装の
 * `ZaicoSyncPort`と共に呼ぶ。このファイル自身は引き続き`server-only`
 * (ZAICO APIを直接呼ぶ`syncSingleZaicoItem`/`syncAllZaicoItems`が
 * `lib/zaico/client.ts`を必要とするため)で、既存のServer Action呼び
 * 出し元(app/actions/zaicoSync.ts)は無修正のまま動作する
 * ——`syncOneZaicoItem`は元の場所からそのままre-exportしているため、
 * import pathの変更も不要。
 *
 * ADMIN enforcement is NOT done here — it's the caller's job
 * (app/actions/zaicoSync.ts, for every sync path), matching how every
 * other Inventory server check at the Server Action boundary, not
 * buried in a shared lib function.
 */

export { syncOneZaicoItem, type ZaicoSyncItemResult };

export interface ZaicoSyncResult {
  startedAt: string;
  finishedAt: string;
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  imageImported: number;
  categoryCreated: number;
  locationCreated: number;
  items: ZaicoSyncItemResult[];
}

function aggregateResult(startedAt: string, items: ZaicoSyncItemResult[]): ZaicoSyncResult {
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    total: items.length,
    created: items.filter((i) => i.status === "created").length,
    updated: items.filter((i) => i.status === "updated").length,
    unchanged: items.filter((i) => i.status === "unchanged").length,
    failed: items.filter((i) => i.status === "failed").length,
    imageImported: items.filter((i) => i.imageImported).length,
    categoryCreated: items.filter((i) => i.categoryCreated).length,
    locationCreated: items.filter((i) => i.locationCreated).length,
    items,
  };
}

/** The Phase 1 test path (spec §30-36): sync exactly one ZAICO item by its numeric id, and only that one. */
export async function syncSingleZaicoItem(zaicoId: string, who: string | null, port: ZaicoSyncPort = getServerSyncPort()): Promise<ZaicoSyncResult> {
  const startedAt = new Date().toISOString();
  const zaicoItem = await getInventory(zaicoId);
  const result = await syncOneZaicoItem(zaicoItem, who, undefined, port);
  return aggregateResult(startedAt, [result]);
}

/**
 * Full-catalog/limited-batch sync (spec §11、AWSテスト環境構築指示
 * §8/§9/§26で追加された安全なテストモード)。One upfront prefetch of
 * every ZAICO-managed BELLO record (fetchAllZaicoManagedInventory) plus
 * ZAICO's own paginated listing (lib/zaico/client.ts's listInventories,
 * throttled/retried internally) — a single blocking Server Action call.
 * 第五ラウンドで新設した`amplify/functions/zaico-sync-worker/`が
 * ブラウザ非依存の主経路になった後も、この関数はADMIN設定画面からの
 * 「今すぐ少数件だけ試したい」という同期的な確認用途に残す
 * (syncLimitedZaicoItems経由、上限50件——過剰設計を避ける)。
 *
 * `options.limit`(AWSテスト環境構築指示 §8: 「初期同期はデフォルトで
 * 全件にしない」)— 指定した場合、その件数に達した時点でZAICO側からの
 * 追加ページ取得も含めて即座に打ち切る。未指定(呼び出し元が明示的に
 * 全件同期を選んだ場合のみ)は既存どおり全件を対象にする — デフォルト
 * 引数ではなくoptional paramにしているのは、"うっかり省略したら全件"
 * ではなく呼び出し側(app/actions/zaicoSync.ts)の各Server Actionが
 * それぞれ明示的にlimitあり/なしを選ぶ形にするため。
 */
export async function syncAllZaicoItems(who: string | null, options: { limit?: number; port?: ZaicoSyncPort } = {}): Promise<ZaicoSyncResult> {
  const port = options.port ?? getServerSyncPort();
  const startedAt = new Date().toISOString();
  const prefetched = await port.fetchAllZaicoManaged();
  // ZAICO級高速化仕様書 §30.7: このrun全体で1個のmasterCacheを使い回す
  // (advanceZaicoBackgroundSyncJobはページ毎に新しいcacheだが、こちら
  // は1リクエスト内で完結する同期なのでrun全体で共有してよい)。
  const masterCache: MasterCache = { categories: new Map(), locations: new Map() };
  const items: ZaicoSyncItemResult[] = [];
  let page = 1;
  // ZAICO API pagination convention (page/per_page, "fewer than
  // requested ⇒ last page") is a best-effort assumption — see
  // lib/zaico/client.ts's listInventories comment; not re-confirmed
  // against a real multi-page response in this environment.
  outer: for (;;) {
    const { items: zaicoItems, hasMore } = await listInventories(page);
    for (const zaicoItem of zaicoItems) {
      items.push(await syncOneZaicoItem(zaicoItem, who, prefetched, port, masterCache));
      if (options.limit !== undefined && items.length >= options.limit) break outer;
    }
    if (!hasMore) break;
    page += 1;
  }
  return aggregateResult(startedAt, items);
}

/**
 * 少数件テスト同期(AWSテスト環境構築指示 §8: 「初期：5〜10商品のみ」)
 * — syncAllZaicoItemsの薄いラッパー。全件同期(syncAllZaicoItems呼び出
 * し側でlimit省略)とは別の名前の関数として呼び出し元(app/actions/
 * zaicoSync.ts)から呼ばれることで、「limitを付け忘れて誤って全件同期
 * してしまう」事故を経路自体で防ぐ意図がある。
 */
export async function syncLimitedZaicoItems(limit: number, who: string | null): Promise<ZaicoSyncResult> {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 1, 50)); // 上限50 — テスト段階で誤って大量実行しないための安全弁
  return syncAllZaicoItems(who, { limit: safeLimit });
}

export interface ZaicoCatalogPreview {
  /** このページ(1ページ目)で実際に取得できた件数。 */
  sampleCount: number;
  /** ZAICO側にまだ次ページがあるかどうか — trueなら実際の総件数はsampleCountより多い。 */
  hasMore: boolean;
}

/**
 * ZAICO側の規模を「同期を実行せずに」確認するための軽量プレビュー
 * (AWSテスト環境構築指示 §8: 「実行前件数表示」)。ZAICOの一覧APIは
 * 総件数を返さない(lib/zaico/client.tsのlistInventories参照)ため、
 * 正確な総数ではなく「1ページ目の件数」と「まだ続きがあるか」だけを
 * 返す — 呼び出し側(UI)は「少なくともN件」「N件以上あります」という
 * 控えめな表現で表示し、実際には無い精度を装わない。
 */
export async function previewZaicoCatalogSize(): Promise<ZaicoCatalogPreview> {
  const { items, hasMore } = await listInventories(1);
  return { sampleCount: items.length, hasMore };
}
