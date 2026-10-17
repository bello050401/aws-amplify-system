import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getUrl } from "aws-amplify/storage/server";
import { runWithAmplifyServerContext } from "@/lib/amplify/serverUtils";
import { getCurrentInventoryUserSub, getInventorySessionStatus } from "@/lib/amplify/requireInventoryUser";
import { listCategories, listLocations, listStatuses, listInventory, listInventorySimpleSearch } from "@/lib/inventory/queries";
import { listInventoryOffsetPage } from "@/lib/inventory/inventoryPage";
import { listInventoryPrimaryPhotoThumbnailsAction } from "@/app/actions/photoRegistration";
import { resolveListPhotoUrl } from "@/lib/photoRegistration/gallerySelection";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };

/** Uses the same credential-validated staff guard and AppSync authorization as the Web UI. */
export async function GET(request: Request) {
  const session = await getInventorySessionStatus();
  if (session.kind !== "authorized") {
    const status = session.kind === "temporarily-unavailable" ? 503 : session.kind === "signed-in-not-authorized" ? 403 : 401;
    return NextResponse.json({ error: status === 503 ? "AUTH_UNAVAILABLE" : status === 403 ? "FORBIDDEN" : "SIGN_IN_REQUIRED" }, { status, headers });
  }
  try {
    const params = new URL(request.url).searchParams;
    const q = (params.get("q") ?? "").trim();
    const category = params.get("category") ?? "";
    const offset = Number(params.get("offset") ?? "0");
    if (q.length > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 50000) {
      return NextResponse.json({ error: "INVALID_QUERY" }, { status: 400, headers });
    }
    const [owner, categories, locations, statuses] = await Promise.all([getCurrentInventoryUserSub(), listCategories(), listLocations(), listStatuses()]);
    if (!owner) return NextResponse.json({ error: "SIGN_IN_REQUIRED" }, { status: 401, headers });
    const categoryId = categories.find((row) => row.name === category)?.id;
    if (category && !categoryId) return NextResponse.json({ owner, role: session.role, items: [], hasMore: false, fetchedAt: new Date().toISOString() }, { headers });
    const filters = { ...(q ? { q } : {}), ...(categoryId ? { categoryIds: [categoryId] } : {}) };
    const options = { offset, limit: 50 };
    const indexed = q ? null : await listInventoryOffsetPage(filters, options);
    const page = indexed?.usedIndex ? indexed : q ? await listInventorySimpleSearch(filters, options) : await listInventory(filters, options);
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
        plannedSalePrice: row.plannedSalePrice, thumbnailUrl, updatedAt: row.updatedAt,
      };
    })) });
    return NextResponse.json({ owner, role: session.role, items, hasMore, fetchedAt: new Date().toISOString() }, { headers });
  } catch {
    return NextResponse.json({ error: "INVENTORY_UNAVAILABLE" }, { status: 503, headers });
  }
}
