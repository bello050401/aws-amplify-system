import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { listCategories, listInventory, listLocations, listStatuses } from "@/lib/inventory/queries";
import { InventoryHeader } from "../InventoryHeader";
import { InventorySidebar } from "./InventorySidebar";
import { InventoryToolbar } from "./InventoryToolbar";
import { InventoryAdvancedSearchPanel } from "./InventoryAdvancedSearchPanel";
import { InventoryTable } from "./InventoryTable";
import { InventoryPagination } from "./InventoryPagination";

interface InventoryListPageProps {
  searchParams: {
    q?: string;
    categoryId?: string;
    locationId?: string;
    statusId?: string;
    advanced?: string;
    cursor?: string;
    stack?: string;
    limit?: string;
  };
}

export default async function InventoryListPage({ searchParams }: InventoryListPageProps) {
  const role = await getInventoryRole();
  // The (protected) layout already redirects a non-authorized visitor
  // before this page ever renders, so `role` is never null here in
  // practice — this narrows the type without duplicating that redirect.
  if (!role) return null;

  const limit = searchParams.limit === "100" ? 100 : 50;
  const advancedOpen = searchParams.advanced === "1";
  const cursorStack = searchParams.stack ? searchParams.stack.split(",") : [];

  const [categories, locations, statuses, listResult] = await Promise.all([
    listCategories(),
    listLocations(),
    listStatuses(),
    listInventory(
      {
        q: searchParams.q,
        categoryId: searchParams.categoryId,
        locationId: searchParams.locationId,
        statusId: searchParams.statusId,
      },
      { cursor: searchParams.cursor, limit },
    ),
  ]);

  // Plain objects, not Maps — this now crosses into InventoryTable, a
  // Client Component (it needs to read the column-visibility preference
  // from localStorage), and a plain object is unambiguously serializable
  // across that server/client boundary.
  const categoriesById = Object.fromEntries(categories.map((c) => [c.id, c]));
  const locationsById = Object.fromEntries(locations.map((l) => [l.id, l]));
  const statusesById = Object.fromEntries(statuses.map((s) => [s.id, s]));

  const baseParams = {
    q: searchParams.q,
    categoryId: searchParams.categoryId,
    locationId: searchParams.locationId,
    statusId: searchParams.statusId,
    advanced: searchParams.advanced,
  };

  return (
    <div className="flex h-full flex-col">
      <InventoryHeader
        role={role}
        center={
          <InventoryToolbar
            role={role}
            q={searchParams.q}
            categoryId={searchParams.categoryId}
            locationId={searchParams.locationId}
            statusId={searchParams.statusId}
            advancedOpen={advancedOpen}
            totalLabel={`${listResult.items.length}件`}
          />
        }
      />
      <div className="flex min-h-0 flex-1">
        <InventorySidebar
          categories={categories}
          locations={locations}
          activeCategoryId={searchParams.categoryId}
          activeLocationId={searchParams.locationId}
          q={searchParams.q}
        />
        {advancedOpen ? (
          <InventoryAdvancedSearchPanel
            categories={categories}
            locations={locations}
            statuses={statuses}
            q={searchParams.q}
            categoryId={searchParams.categoryId}
            locationId={searchParams.locationId}
            statusId={searchParams.statusId}
          />
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <InventoryTable
              rows={listResult.items}
              categoriesById={categoriesById}
              locationsById={locationsById}
              statusesById={statusesById}
            />
          </div>
          <InventoryPagination
            baseParams={baseParams}
            cursor={searchParams.cursor}
            cursorStack={cursorStack}
            nextToken={listResult.nextToken}
            limit={limit}
            currentCount={listResult.items.length}
          />
        </div>
      </div>
    </div>
  );
}
