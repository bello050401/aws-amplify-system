import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import {
  listCategories,
  listCustomFieldDefinitions,
  listInventory,
  listInventoryAdvanced,
  listInventorySimpleSearch,
  listLocations,
  listStatuses,
} from "@/lib/inventory/queries";
import { buildSearchFieldDefs, completeConditions, type AdvancedSearchQuery } from "@/lib/inventory/advancedSearch";
import { listInventoryOffsetPage } from "@/lib/inventory/inventoryPage";
import { InventoryTotalCount } from "./InventoryTotalCount";
import { InventoryHeader } from "../InventoryHeader";
import { DirectEditProvider } from "./DirectEditProvider";
import { InventorySelectionProvider } from "./InventorySelectionProvider";
import { InventorySidebar } from "./InventorySidebar";
import { InventoryToolbar } from "./InventoryToolbar";
import { InventoryAdvancedSearchPanel } from "./InventoryAdvancedSearchPanel";
import { InventoryTable } from "./InventoryTable";
import { InventoryPagination } from "./InventoryPagination";

interface InventoryListPageProps {
  searchParams: {
    q?: string;
    categoryIds?: string; // comma-separated (統合改善指示書 §9: 複数カテゴリOR)
    locationId?: string;
    statusId?: string;
    advanced?: string;
    /** 詳細検索の実際の条件 — JSON文字列(lib/inventory/advancedSearch.tsのAdvancedSearchQuery)。存在し、有効な条件を1件以上含む場合のみ詳細検索モードになる。 */
    adv?: string;
    limit?: string;
    offset?: string;
  };
}

function parseAdvancedQuery(raw: string | undefined): AdvancedSearchQuery | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AdvancedSearchQuery;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.conditions)) return null;
    return { combinator: parsed.combinator === "OR" ? "OR" : "AND", conditions: parsed.conditions };
  } catch {
    return null; // 壊れた/手編集されたURLは「詳細検索なし」として無視する — エラー画面にしない
  }
}

export default async function InventoryListPage({ searchParams }: InventoryListPageProps) {
  const role = await getInventoryRole();
  // The (protected) layout already redirects a non-authorized visitor
  // before this page ever renders, so `role` is never null here in
  // practice — this narrows the type without duplicating that redirect.
  if (!role) return null;

  const limit = searchParams.limit === "100" ? 100 : 50;
  const advancedOpen = searchParams.advanced === "1";
  const categoryIds = searchParams.categoryIds ? searchParams.categoryIds.split(",").filter(Boolean) : [];
  const offset = Math.max(0, Number(searchParams.offset) || 0);

  const advancedQueryRaw = parseAdvancedQuery(searchParams.adv);
  const advancedConditions = advancedQueryRaw ? completeConditions(advancedQueryRaw) : [];
  // 有効な条件が1件も無いadvクエリ(全部空欄のまま送信した等)は詳細検索
  // モードとして扱わない — 通常の一覧表示にフォールバックする。
  const advancedQuery: AdvancedSearchQuery | null =
    advancedQueryRaw && advancedConditions.length > 0 ? { ...advancedQueryRaw, conditions: advancedConditions } : null;
  const hasQuickSearchText = Boolean(searchParams.q?.trim());
  // 詳細検索が有効な間はサイドバー/クイック検索の単純条件を無視する
  // (詳細検索は既存の単純フィルタを置き換える — 両方を同時に組み合わ
  // せるUIは今回のスコープ外、混乱を避けるため)。
  const searchMode: "advanced" | "quick" | "plain" = advancedQuery ? "advanced" : hasQuickSearchText ? "quick" : "plain";

  const [categories, locations, statuses, customFieldDefs] = await Promise.all([
    listCategories(),
    listLocations(),
    listStatuses(),
    listCustomFieldDefinitions(),
  ]);

  const fieldDefs = buildSearchFieldDefs(customFieldDefs, { categories, locations, statuses });
  const fieldsByKey = new Map(fieldDefs.map((f) => [f.key, f]));

  // 検索していない通常の一覧（＝日常的に最も多い経路）は、GSIへの
  // Queryで**表示するページだけ**を取る。従来はここで全5,313件を読んで
  // から50件をsliceしており、実測でTTFB約8秒のほぼ全部がこれだった。
  //
  // テキスト検索・詳細検索は、条件がDynamoDBのKeyCondition/Filterだけ
  // では表現できない（部分一致・AND/OR混在）ので従来経路のまま。
  // 検索は利用者が明示的に行う操作で、一覧を開くたびに走るものではない。
  const filters = { categoryIds, locationId: searchParams.locationId, statusId: searchParams.statusId };
  const pagedResult = searchMode === "plain" ? await listInventoryOffsetPage(filters, { offset, limit }) : null;

  // GSIに1件も出てこない場合（バックフィル未完了など）は、黙って0件と
  // 表示せず従来経路へ落とす。§13.2「エラーや取りこぼしを0件と混同しない」。
  const fallbackNeeded = pagedResult !== null && !pagedResult.usedIndex;

  const listResult =
    searchMode === "advanced" && advancedQuery
      ? await listInventoryAdvanced(advancedQuery, fieldsByKey, { offset, limit })
      : searchMode === "quick"
        ? await listInventorySimpleSearch(
            { q: searchParams.q, categoryIds, locationId: searchParams.locationId, statusId: searchParams.statusId },
            { offset, limit },
          )
        : fallbackNeeded
          ? await listInventory(filters, { offset, limit })
          : null;

  const rows = listResult ? listResult.items : pagedResult!.items;
  // 総件数は行の表示を待たせない（Suspenseで後から差し込む）。検索経路は
  // 従来どおり集計済みの値をそのまま使う。
  const knownTotal = listResult ? listResult.total : null;
  const hasNext = listResult ? listResult.offset + limit < listResult.total : pagedResult!.hasNext;

  // Plain objects, not Maps — this now crosses into InventoryTable, a
  // Client Component (it needs to read the column-visibility preference
  // from localStorage), and a plain object is unambiguously serializable
  // across that server/client boundary.
  const categoriesById = Object.fromEntries(categories.map((c) => [c.id, c]));
  const locationsById = Object.fromEntries(locations.map((l) => [l.id, l]));
  const statusesById = Object.fromEntries(statuses.map((s) => [s.id, s]));

  const baseParams = {
    q: searchParams.q,
    categoryIds: categoryIds.length > 0 ? categoryIds.join(",") : undefined,
    locationId: searchParams.locationId,
    statusId: searchParams.statusId,
    advanced: searchParams.advanced,
    adv: searchParams.adv,
  };

  // BELLO統合改修 master指示書 §8修正後: 3経路すべてがlib/inventory/
  // queries.tsのfetchAllInventoryRecordsベースのSearchPage(常に
  // `total`を含む)を返すため、これはもう「ページ内件数」へフォール
  // バックする必要がない — フィルタ/検索条件に対する正確な総件数。
  // 検索経路はすでに件数を持っているのでそのまま出す。通常の一覧は
  // 描画後にクライアントから取りに行く（サーバー描画に全件走査を
  // 含めない — 含めると、その失敗が画面ごと巻き込む）。
  const totalLabel =
    knownTotal !== null ? `${knownTotal.toLocaleString("ja-JP")}件` : <InventoryTotalCount filters={filters} />;

  return (
    // DirectEditProvider (一覧直接編集の状態) wraps both InventoryHeader's
    // center content (InventoryToolbar's 直接編集ボタン/DirectEditControls)
    // and the table body below — they're siblings in the DOM but share
    // one Context so the header button can drive what the table renders.
    // See that file's own comment.
    <InventorySelectionProvider>
    <DirectEditProvider rows={rows}>
      <div className="flex h-full flex-col">
        <InventoryHeader
          role={role}
          center={
            <InventoryToolbar
              role={role}
              q={searchParams.q}
              categoryIds={categoryIds}
              locationId={searchParams.locationId}
              statusId={searchParams.statusId}
              advancedOpen={advancedOpen}
              advancedActive={searchMode === "advanced"}
              advRaw={searchParams.adv}
              totalLabel={totalLabel}
            />
          }
        />
        {/*
          第六ラウンド§17-18(P0-4)で実機発見・修正: この行が常時
          `flex`(=flex-row)だったため、InventorySidebarのモバイル用
          トリガーバー(`md:hidden`の細い横長バーのつもり)が、
          flex-rowの兄弟要素(InventoryTable側の高さいっぱいの列)と
          並んだ結果、既定の`align-items: stretch`でその高さ
          (692px相当)いっぱいまで縦に引き伸ばされ、幅111px×高さ
          フル画面という縦長の帯になっていた——ユーザーが実iPhoneで
          見た「左ナビ/保管場所/カテゴリが大きすぎ、商品一覧が右へ
          押し出されている」の実際の原因はこれだった(overflow=0の
          Playwright E2Eではこの「幅は小さいが縦に伸び切って隣を圧迫
          する」形の不具合を検出できていなかった——第五ラウンドP1-Aの
          限界そのもの)。`md:flex-row`(デスクトップは従来通り横並び)
          `flex-col`(モバイルは縦積み——フィルターバーが上、一覧が下)
          で修正する。
        */}
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <InventorySidebar
            categories={categories}
            locations={locations}
            activeCategoryIds={categoryIds}
            activeLocationId={searchParams.locationId}
            q={searchParams.q}
          />
          {advancedOpen ? (
            <InventoryAdvancedSearchPanel fieldDefs={fieldDefs} initialQuery={advancedQueryRaw} />
          ) : null}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1">
              <InventoryTable
                rows={rows}
                categories={categories}
                locations={locations}
                categoriesById={categoriesById}
                locationsById={locationsById}
                statusesById={statusesById}
                customFieldDefs={customFieldDefs}
              />
            </div>
            <InventoryPagination
              baseParams={baseParams}
              offset={offset}
              total={knownTotal}
              limit={limit}
              currentCount={rows.length}
              hasNext={hasNext}
            />
          </div>
        </div>
      </div>
    </DirectEditProvider>
    </InventorySelectionProvider>
  );
}
