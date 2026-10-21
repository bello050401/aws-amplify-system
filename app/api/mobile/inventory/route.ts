import {inventoryCategoryIds} from '@/lib/inventory/categories';
import { NextResponse } from "next/server";
import { getMobileSession } from "@/lib/mobile/session";
import { buildSearchFieldDefs, emptyAdvancedQuery } from "@/lib/inventory/advancedSearch";
import { mobileSearchFields, searchValidation, DEFAULT_INVENTORY_SORT, type AdvancedSearchQuery, type InventorySort } from "@/mobile/src/domain/search";
import { listCategories, listLocations, listStatuses, listInventory, listInventoryMobileSearch, listCustomFieldDefinitions, getInventoryDetail } from "@/lib/inventory/queries";
import { listInventoryOffsetPage } from "@/lib/inventory/inventoryPage";
import { inventoryThumbnails } from "@/lib/mobile/inventoryThumbnails";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };

/** Uses the same credential-validated staff guard and AppSync authorization as the Web UI. */
export async function GET(request: Request) {
  const session = await getMobileSession();
  if (!session.ok) return NextResponse.json({error:session.error},{status:session.status,headers});
  try {
    const params = new URL(request.url).searchParams;
    const q = (params.get("q") ?? "").trim();
    const category = params.get("category") ?? "";
    const offset = Number(params.get("offset") ?? "0");
    const images = params.get("images") ?? "included";
    if (q.length > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 50000 || !["included", "deferred", "only"].includes(images)) {
      return NextResponse.json({ error: "INVALID_QUERY" }, { status: 400, headers });
    }
    const {owner} = session;
    if (images === "only") {
      const ids = (params.get("ids") ?? "").split(",");
      if (ids.length > 50 || ids.some(id => !/^[a-zA-Z0-9_-]{1,100}$/.test(id))) {
        return NextResponse.json({ error: "INVALID_QUERY" }, { status: 400, headers });
      }
      // Fetch only the displayed IDs, avoiding a second full search or changing page membership.
      const rows = await Promise.all([...new Set(ids)].map(id => getInventoryDetail(id)));
      const items = await inventoryThumbnails(rows.filter(row => row !== null));
      return NextResponse.json({ owner, items }, { headers });
    }
    const [categories, locations, statuses, customFields] = await Promise.all([listCategories(), listLocations(), listStatuses(), listCustomFieldDefinitions()]);
    if (!owner) return NextResponse.json({ error: "SIGN_IN_REQUIRED" }, { status: 401, headers });
    const categoryId = categories.find((row) => row.name === category)?.id;
    if (category && !categoryId) return NextResponse.json({ owner, role: session.role, items: [], hasMore: false, fetchedAt: new Date().toISOString() }, { headers });
    const fields = mobileSearchFields(buildSearchFieldDefs(customFields,{categories,locations,statuses}), session.features);
    let advanced: AdvancedSearchQuery, sort: InventorySort;
    try {
      const rawAdvanced=params.get("advanced"), rawSort=params.get("sort");
      if ((rawAdvanced?.length ?? 0)>20000 || (rawSort?.length ?? 0)>500) throw new Error();
      advanced=rawAdvanced ? JSON.parse(rawAdvanced) : emptyAdvancedQuery();
      sort=rawSort ? JSON.parse(rawSort) : DEFAULT_INVENTORY_SORT;
      if (searchValidation(advanced,fields) || !sort || !["asc","desc"].includes(sort.direction) || !fields.some(field=>field.key===sort.field)) throw new Error();
    } catch {return NextResponse.json({error:"INVALID_QUERY"},{status:400,headers});}
    const filters = { ...(q ? { q } : {}), ...(categoryId ? { categoryIds: [categoryId] } : {}) };
    const options = { offset, limit: 50 };
    const fullSearch = Boolean(q) || advanced.conditions.length > 0 || sort.field !== "updatedAt" || sort.direction !== "desc";
    const indexed = fullSearch ? null : await listInventoryOffsetPage(filters, options);
    const page = fullSearch ? await listInventoryMobileSearch({...filters,advanced,sort},new Map(fields.map(field=>[field.key,field])),options) : indexed?.usedIndex ? indexed : await listInventory(filters, options);
    // Product names and quantities must not wait for 50 photo lookups/signatures.
    // Older clients keep the complete response; current clients fetch images separately.
    const thumbnails = images === "deferred" ? [] : await inventoryThumbnails(page.items);
    const imageById = new Map(thumbnails.map(image => [image.id, image.thumbnailUrl]));
    const hasMore = "hasNext" in page ? page.hasNext : page.offset + page.items.length < page.total;
    const categoryNames = new Map(categories.map((row) => [row.id, row.name]));
    const locationNames = new Map(locations.map((row) => [row.id, row.name]));
    const statusLabels = new Map(statuses.map((row) => [row.id, row.label]));
    const items = page.items.map(row => {
      return {
        id: row.id, sku: row.sku, displayId: row.displayId, name: row.name, quantity: row.quantity, unit: row.unit ?? "",
        quantityUnset:row.quantityUnset,
        location: (row.locationId && locationNames.get(row.locationId)) || "",
        category: inventoryCategoryIds(row).map(id=>categoryNames.get(id)).filter(Boolean).join(","),
        statusId: row.statusId, condition: (row.statusId && statusLabels.get(row.statusId)) || "", note: row.note ?? "", barcode: row.barcode ?? "",
        plannedSalePrice: row.plannedSalePrice, thumbnailUrl: imageById.get(row.id) ?? null, createdAt: row.createdAt, updatedAt: row.updatedAt, listUpdatedAt: row.listUpdatedAt ?? undefined,
      };
    });
    return NextResponse.json({ owner, role: session.role, items, imagesDeferred: images === "deferred", hasMore, nextOffset: offset+50, total: "total" in page ? page.total : null, totalQuantity: "totalQuantity" in page ? page.totalQuantity : null, fetchedAt: new Date().toISOString() }, { headers });
  } catch {
    return NextResponse.json({ error: "INVENTORY_UNAVAILABLE" }, { status: 503, headers });
  }
}
