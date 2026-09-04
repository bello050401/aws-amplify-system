/**
 * 主要画面のサーバー側データ読み込みを実測する(2026-09-04 性能総点検)。
 *
 *   AWS_PROFILE=Bello npm run measure:page-loads
 *
 * ── なぜブラウザで測らないのか ──────────────────────────────────
 *
 * 最初はローカルの Next.js を実データへ向けて Playwright で測ろうとした。
 * 2つの壁で成立しなかった:
 *
 *   1. `next start`(本番ビルド)では NODE_ENV がビルド時に埋め込まれる
 *      ため、開発機の認証バイパス(NODE_ENV!=="production" が条件)が
 *      構造的に通らない —— 実際に 307 でログインへ戻された。
 *   2. `next dev` はコンパイル時に Google Fonts を取りに行く。この環境は
 *      そこへ到達できず、コンパイルがタイムアウトする。
 *
 * Staging へブラウザでログインする道もあるが、資格情報がこの環境に
 * 登録されていない(利用者本人しか登録できない)。
 *
 * ── 代わりに何を測るか ──────────────────────────────────────────
 *
 * **各画面が実際に呼んでいるデータ読み込み関数を、同じ順序・同じ
 * 並列度でそのまま呼ぶ。** 画面のコードと同じ関数なので、往復回数も
 * 直列/並列の構造も本物と同じ。実データ(在庫5,329件)へ当てる。
 *
 * ── 数字の読み方 ────────────────────────────────────────────────
 *
 * ここに出るのは **DynamoDB 直結**の時間。本番は AppSync を挟むので
 * 1呼び出しあたりの固定費がこれより大きい。またこの端末から
 * us-west-2 までの往復に約160msかかっており(Amplify上なら同一
 * リージョンで数ms)、絶対値はそのぶん大きく出る。
 *
 * **比べてよいのは「同じ条件での変更前後」と「往復回数」。**
 * 絶対値の議論には measure:staging-http(実Stagingの応答時間)を使う。
 */
import { ensureConversationTableName } from "./lib/resolveStagingTables";

process.env.BELLO_QUERY_TIMING = "1";

interface PageResult {
  screen: string;
  totalMs: number;
  queries: number;
  /** データアクセスの合計時間。totalとの差が「直列に待った時間」以外の処理。 */
  dbMs: number;
  detail: string[];
}

const results: PageResult[] = [];

async function main() {
  await ensureConversationTableName();

  const { runWithDirectData } = await import("@/lib/amplify/dataClient");
  const { currentQueryTimings } = await import("@/lib/perf/queryTiming");
  const q = await import("@/lib/inventory/queries");
  const { listInventoryOffsetPage } = await import("@/lib/inventory/inventoryPage");
  const { countActiveInventory } = await import("@/lib/inventory/inventoryPage");
  const { getListingDraftForInventory, getChannelListing } = await import("@/lib/listing/service");
  const { invalidateMasterCache } = await import("@/lib/inventory/masterCache");

  /** 1画面ぶんを測る。マスタのキャッシュ状態を指定できる。 */
  async function page(screen: string, warmMasters: boolean, run: () => Promise<void>): Promise<void> {
    if (!warmMasters) invalidateMasterCache();
    const timings: { model: string; op: string; ms: number; items: number | null }[] = [];
    const started = performance.now();
    await runWithDirectData(async () => {
      const { withQueryTiming } = await import("@/lib/perf/queryTiming");
      await withQueryTiming(screen, async () => {
        await run();
        timings.push(...currentQueryTimings());
      });
    });
    const totalMs = performance.now() - started;
    const dbMs = timings.reduce((s, t) => s + t.ms, 0);
    results.push({
      screen,
      totalMs: Math.round(totalMs),
      queries: timings.length,
      dbMs: Math.round(dbMs),
      detail: timings
        .sort((a, b) => b.ms - a.ms)
        .map((t) => `${Math.round(t.ms)}ms ${t.model}.${t.op}${t.items != null ? `(${t.items})` : ""}`),
    });
    console.log(
      `  ${screen.padEnd(30)} ${String(Math.round(totalMs)).padStart(6)}ms  問い合わせ${String(timings.length).padStart(2)}本(計${Math.round(dbMs)}ms)`,
    );
  }

  console.log(`[measure-page-loads] ${new Date().toISOString()}`);
  console.log("  実データ(Staging)へ直結して、各画面の読み込み関数をそのまま実行します。\n");

  // 計測対象の在庫を1件取る。
  const firstPage = await runWithDirectData(() => listInventoryOffsetPage({}, { offset: 0, limit: 1 }));
  const inventoryId = firstPage.items[0]?.id ?? "";
  if (!inventoryId) throw new Error("計測対象の在庫を取得できませんでした。");

  console.log("■ 初回(マスタのキャッシュが空の状態＝ログイン直後の1画面目)");

  // ── 在庫一覧 ────────────────────────────────────────────────
  //
  // いまのページの構造(app/inventory/(protected)/page.tsx)と同じ:
  // 在庫の取得を先に始め、マスタ4種と**同時に**待つ。
  await page("在庫一覧", false, async () => {
    const listPromise = listInventoryOffsetPage({}, { offset: 0, limit: 50 });
    await Promise.all([q.listCategories(), q.listLocations(), q.listStatuses(), q.listCustomFieldDefinitions()]);
    await listPromise;
  });

  // 比較用: 直列(2026-09-04 の修正前の構造)。同じ関数を順番に待つだけ。
  await page("在庫一覧【修正前の直列構造】", false, async () => {
    await Promise.all([q.listCategories(), q.listLocations(), q.listStatuses(), q.listCustomFieldDefinitions()]);
    await listInventoryOffsetPage({}, { offset: 0, limit: 50 });
  });

  // ── 商品詳細 ────────────────────────────────────────────────
  await page("商品詳細", false, async () => {
    const [item] = await Promise.all([q.getInventoryDetail(inventoryId), q.listStatuses(), q.listCustomFieldDefinitions()]);
    await Promise.all([q.listCategories(item?.categoryId ?? null), q.listLocations(item?.locationId ?? null)]);
  });

  // ── EC出品 ──────────────────────────────────────────────────
  await page("EC出品", false, async () => {
    const item = await q.getInventoryDetail(inventoryId);
    await Promise.all([
      getListingDraftForInventory(inventoryId),
      getChannelListing(inventoryId, "MERCARI_SHOPS"),
      q.listCategories(item?.categoryId ?? null),
      q.listStatuses(),
    ]);
  });

  // ── 件数(一覧の描画後にクライアントから呼ばれる) ───────────
  await page("在庫の総件数(一覧の裏で走る)", true, async () => {
    await countActiveInventory({});
  });

  console.log("\n■ 2画面目以降(マスタのキャッシュが温まった状態)");
  await page("在庫一覧(2画面目)", true, async () => {
    const listPromise = listInventoryOffsetPage({}, { offset: 0, limit: 50 });
    await Promise.all([q.listCategories(), q.listLocations(), q.listStatuses(), q.listCustomFieldDefinitions()]);
    await listPromise;
  });
  await page("在庫一覧(2画面目)【修正前の直列構造】", true, async () => {
    await Promise.all([q.listCategories(), q.listLocations(), q.listStatuses(), q.listCustomFieldDefinitions()]);
    await listInventoryOffsetPage({}, { offset: 0, limit: 50 });
  });
  await page("商品詳細(2画面目)", true, async () => {
    const [item] = await Promise.all([q.getInventoryDetail(inventoryId), q.listStatuses(), q.listCustomFieldDefinitions()]);
    await Promise.all([q.listCategories(item?.categoryId ?? null), q.listLocations(item?.locationId ?? null)]);
  });
  await page("EC出品(2画面目)", true, async () => {
    const item = await q.getInventoryDetail(inventoryId);
    await Promise.all([
      getListingDraftForInventory(inventoryId),
      getChannelListing(inventoryId, "MERCARI_SHOPS"),
      q.listCategories(item?.categoryId ?? null),
      q.listStatuses(),
    ]);
  });

  console.log("\n══ 内訳 ══");
  for (const r of results) {
    console.log(`\n  ${r.screen} — ${r.totalMs}ms / 問い合わせ${r.queries}本`);
    for (const d of r.detail) console.log(`      ${d}`);
  }

  console.log("\n※ DynamoDB 直結の時間です。本番は AppSync の往復が1呼び出しごとに加わります。");
  console.log("  この端末から us-west-2 までの往復に約160msかかっており、絶対値はそのぶん大きく出ます。");
}

void main().catch((err) => {
  console.error(`[measure-page-loads] 失敗: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
