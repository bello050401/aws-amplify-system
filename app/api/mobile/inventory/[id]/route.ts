import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getUrl } from "aws-amplify/storage/server";
import { runWithAmplifyServerContext } from "@/lib/amplify/serverUtils";
import { getMobileSession } from "@/lib/mobile/session";
import { getInventoryDetail, listCategories, listLocations, listStatuses } from "@/lib/inventory/queries";
import { mobileInventoryDetail } from "@/lib/mobile/inventoryDetail";
import { mobileInventoryPhotos } from "@/lib/mobile/inventoryPhotos";
import { listInventoryPhotoAssetsAction } from "@/app/actions/photoRegistration";
import { updateInventory } from "@/app/actions/inventory";
import { InventorySaveError } from "@/lib/inventory/conditionalUpdate";
import { parseMobileSave, mobileInventoryInput, mobileWriteWasApplied, MobileWriteValidationError } from "@/lib/mobile/inventoryWrite";

export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: { id: string } }) {
  const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
  const session = await getMobileSession();
  if (!session.ok) return NextResponse.json({ error: session.error }, { status: session.status, headers });
  const { id } = context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return NextResponse.json({ error: "INVALID_ID" }, { status: 400, headers });
  try {
    const row = await getInventoryDetail(id);
    if (!row) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404, headers });
    const [categories, locations, statuses, assetResult] = await Promise.all([
      listCategories(row.categoryId), listLocations(row.locationId), listStatuses(),
      listInventoryPhotoAssetsAction(id).catch(() => null),
    ]);
    const photos = await runWithAmplifyServerContext({ nextServerContext: { cookies }, operation: authContext =>
      mobileInventoryPhotos(row.images, assetResult?.ok ? assetResult.value.assets : [], async path => {
        const image = await getUrl(authContext, { path, options: { expiresIn: 900 } });
        return image.url.toString();
      }),
    });
    const item = mobileInventoryDetail(row, categories, locations, statuses, session.features, photos, new Date().toISOString());
    item.photosComplete = Boolean(assetResult?.ok && !assetResult.value.truncated && photos.every(photo => photo.url));
    return NextResponse.json({ owner: session.owner, item }, { headers });
  } catch { return NextResponse.json({ error: "INVENTORY_UNAVAILABLE" }, { status: 503, headers }); }
}

/** Native clients use the same BELLO save action as the Web editor. No direct ZAICO calls. */
export async function PATCH(request: Request, context: { params: { id: string } }) {
  const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
  const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers });
  const session = await getMobileSession();
  if (!session.ok) return fail(session.error, session.status);
  if (session.role === "VIEWER") return fail("FORBIDDEN", 403);
  if (process.env.BELLO_MOBILE_WRITES_ENABLED !== "true") return fail("WRITES_DISABLED", 403);
  // JSON + a custom header prevents cross-site forms. Browser callers must be same-origin.
  const origin = request.headers.get("origin");
  const publicOrigin = process.env.BELLO_MOBILE_PUBLIC_ORIGIN || new URL(request.url).origin;
  if (request.headers.get("x-bello-mobile") !== "1" || request.headers.get("sec-fetch-site") === "cross-site" ||
      (origin && origin !== publicOrigin)) return fail("FORBIDDEN", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return fail("INVALID_INPUT", 415);
  if (Number(request.headers.get("content-length")) > 65536) return fail("INVALID_INPUT", 413);
  let raw: unknown;
  try {
    // Bound streaming bodies too; an omitted Content-Length must not bypass the limit.
    const reader = request.body?.getReader();
    if (!reader) return fail("INVALID_INPUT", 400);
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 65536) { await reader.cancel(); return fail("INVALID_INPUT", 413); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { return fail("INVALID_INPUT", 400); }
  try {
    const body = parseMobileSave(raw, context.params.id);
    const row = await getInventoryDetail(body.id);
    if (!row) return fail("NOT_FOUND", 404);
    // A previous response may have been lost. Confirm the receipt before attempting a write.
    if (!mobileWriteWasApplied(row, body, session.owner)) {
      const [categories, locations, statuses] = await Promise.all([listCategories(row.categoryId), listLocations(row.locationId), listStatuses()]);
      const input = mobileInventoryInput(row, body, session.owner, session.features, categories, locations, statuses);
      try { await updateInventory(body.id, input, { skipRedirect: true }); }
      catch (error) {
        // Also handles two simultaneous retries: only one conditional write may succeed.
        const latest = await getInventoryDetail(body.id).catch(() => null);
        if (!latest || !mobileWriteWasApplied(latest, body, session.owner)) throw error;
      }
    }
    const confirmed = await getInventoryDetail(body.id);
    if (!confirmed || !mobileWriteWasApplied(confirmed, body, session.owner)) return fail("UNCONFIRMED", 503);
    const response = await GET(request, context);
    if (!response.ok) return fail("UNCONFIRMED", 503);
    const payload = await response.json();
    if (payload.owner !== session.owner || payload.item?.id !== body.id ||
        !(Date.parse(payload.item.updatedAt) >= Date.parse(confirmed.updatedAt))) return fail("UNCONFIRMED", 503);
    return NextResponse.json({ ...payload, mutationId: body.mutationId }, { headers });
  } catch (error) {
    if (error instanceof MobileWriteValidationError) return fail(error.code, error.code === "FIELD_FORBIDDEN" ? 403 : 422);
    if (error instanceof InventorySaveError && error.code === "CONFLICT") return fail("CONFLICT", 409);
    // A failure after submission is not proof that the data was not saved.
    return fail("UNCONFIRMED", 503);
  }
}
