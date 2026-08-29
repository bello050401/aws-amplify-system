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
import { InventoryHeader } from "../InventoryHeader";
import { DirectEditProvider } from "./DirectEditProvider";
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

  const listResult =
    searchMode === "advanced" && advancedQuery
      ? await listInventoryAdvanced(advancedQuery, fieldsByKey, { offset, limit })
      : searchMode === "quick"
        ? await listInventorySimpleSearch(
            { q: searchParams.q, categoryIds, locationId: searchParams.locationId, statusId: searchParams.statusId },
            { offset, limit },
          )
        : await listInventory({ categoryIds, locationId: searchParams.locationId, statusId: searchParams.statusId }, { offset, limit });

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
  const totalLabel = `${listResult.total.toLocaleString("ja-JP")}件`;

  return (
    // DirectEditProvider (一覧直接編集の状態) wraps both InventoryHeader's
    // center content (InventoryToolbar's 直接編集ボタン/DirectEditControls)
    // and the table body below — they're siblings in the DOM but share
    // one Context so the header button can drive what the table renders.
    // See that file's own comment.
    <DirectEditProvider rows={listResult.items}>
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
        <div className="flex min-h-0 flex-1">
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
                rows={listResult.items}
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
              offset={listResult.offset}
              total={listResult.total}
              limit={limit}
              currentCount={listResult.items.length}
            />
          </div>
        </div>
      </div>
    </DirectEditProvider>
  );
}
