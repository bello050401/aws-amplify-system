import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getUrl } from "aws-amplify/storage/server";
import { runWithAmplifyServerContext } from "@/lib/amplify/serverUtils";
import { getMobileSession } from "@/lib/mobile/session";
import { buildSearchFieldDefs, emptyAdvancedQuery } from "@/lib/inventory/advancedSearch";
import { mobileSearchFields, searchValidation, DEFAULT_INVENTORY_SORT, type AdvancedSearchQuery, type InventorySort } from "@/mobile/src/domain/search";
import { listCategories, listLocations, listStatuses, listInventory, listInventoryMobileSearch, listCustomFieldDefinitions } from "@/lib/inventory/queries";
import { listInventoryOffsetPage } from "@/lib/inventory/inventoryPage";
import { listInventoryPrimaryPhotoThumbnailsAction } from "@/app/actions/photoRegistration";
import { resolveListPhotoUrl } from "@/lib/photoRegistration/gallerySelection";

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
    if (q.length > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 50000) {
      return NextResponse.json({ error: "INVALID_QUERY" }, { status: 400, headers });
    }
    const {owner} = session;
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
    const photoResult = await listInventoryPrimaryPhotoThumbnailsAction(page.items.map(row => row.id)).catch(() => null);
    const hasMore = "hasNext" in page ? page.hasNext : page.offset + page.items.length < page.total;
    const categoryNames = new Map(categories.map((row) => [row.id, row.name]));
    const locationNames = new Map(locations.map((row) => [row.id, row.name]));
    const statusLabels = new Map(statuses.map((row) => [row.id, row.label]));
    const items = await runWithAmplifyServerContext({ nextServerContext: { cookies }, operation: async (context) => Promise.all(page.items.map(async (row) => {
      const key = row.mainImageThumbnailKey ?? row.mainImageStorageKey;
      const photoUrl = resolveListPhotoUrl(row.mainImageIsPrimary, photoResult?.ok ? photoResult.value[row.id] : null);
      const thumbnailUrl = photoUrl ?? (key ? await getUrl(context, { path: key, options: { expiresIn: 900 } }).then((image) => image.url.toString()).catch(() => null) : null);
      return {
        id: row.id, sku: row.sku, displayId: row.displayId, name: row.name, quantity: row.quantity, unit: row.unit ?? "",
        location: (row.locationId && locationNames.get(row.locationId)) || "",
        category: (row.categoryId && categoryNames.get(row.categoryId)) || "",
        statusId: row.statusId, condition: (row.statusId && statusLabels.get(row.statusId)) || "", note: row.note ?? "", barcode: row.barcode ?? "",
        plannedSalePrice: row.plannedSalePrice, thumbnailUrl, createdAt: row.createdAt, updatedAt: row.updatedAt,
      };
    })) });
    return NextResponse.json({ owner, role: session.role, items, hasMore, nextOffset: offset+50, total: "total" in page ? page.total : null, totalQuantity: "totalQuantity" in page ? page.totalQuantity : null, fetchedAt: new Date().toISOString() }, { headers });
  } catch {
    return NextResponse.json({ error: "INVENTORY_UNAVAILABLE" }, { status: 503, headers });
  }
}
