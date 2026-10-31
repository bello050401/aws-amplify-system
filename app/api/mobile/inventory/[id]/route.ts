import { NextResponse } from "next/server";
import { signInventoryListKey } from "@/lib/inventory/listImageUrls";
import { getMobileSession } from "@/lib/mobile/session";
import { getInventoryDetail, listCategories, listLocations, listStatuses } from "@/lib/inventory/queries";
import { mobileInventoryDetail } from "@/lib/mobile/inventoryDetail";
import { mobileInventoryPhotos } from "@/lib/mobile/inventoryPhotos";
import { listInventoryPhotoAssetsAction } from "@/app/actions/photoRegistration";
import { createInventory, updateInventory, deleteInventory } from "@/app/actions/inventory";
import { InventorySaveError, InventoryMutationRejected } from "@/lib/inventory/conditionalUpdate";
import { parseMobileSave, mobileCreateInput, mobileCopyInput, mobileInventoryInput, mobileWriteWasApplied, MobileWriteValidationError } from "@/lib/mobile/inventoryWrite";

export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const started = Date.now();
  const timing: Record<string, number> = {};
  const measure = async <T,>(name: string, run: () => Promise<T>): Promise<T> => {
    const at = Date.now();
    try { return await run(); } finally { timing[name] = Date.now() - at; }
  };
  const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
  const session = await measure('session', getMobileSession);
  if (!session.ok) return NextResponse.json({ error: session.error }, { status: session.status, headers });
  const { id } = (await context.params);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return NextResponse.json({ error: "INVALID_ID" }, { status: 400, headers });
  try {
    // Start independent reads after authorization. Master choices must not wait
    // for the item, particularly when this server's master cache is still cold.
    const [row, assetResult, activeCategories, activeLocations, statuses] = await Promise.all([
      measure('inventory', () => getInventoryDetail(id, {consistentDirectRead: true})), measure('photoAssets', () => listInventoryPhotoAssetsAction(id)).catch(() => null),
      measure('categories', () => listCategories()), measure('locations', () => listLocations()), measure('statuses', listStatuses),
    ]);
    if (!row) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404, headers });
    // Existing records may reference a retired choice. Preserve it exactly as
    // before; only that exceptional lookup depends on the item's current IDs.
    const [categories, locations] = await Promise.all([
      row.categoryId && !activeCategories.some(option => option.id === row.categoryId)
        ? measure('inactiveCategory', () => listCategories(row.categoryId)) : activeCategories,
      row.locationId && !activeLocations.some(option => option.id === row.locationId)
        ? measure('inactiveLocation', () => listLocations(row.locationId)) : activeLocations,
    ]);
    const photos = await mobileInventoryPhotos(row.images, assetResult?.ok ? assetResult.value.assets : [], async path => {
      const url = await signInventoryListKey(path);
      if (!url) throw new Error("IMAGE_UNAVAILABLE");
      return url;
    });
    const item = mobileInventoryDetail(row, categories, locations, statuses, session.features, photos, new Date().toISOString());
    item.photosComplete = Boolean(assetResult?.ok && !assetResult.value.truncated && photos.every(photo => photo.url));
    // Explicit administrator-only diagnostics contain durations, never tokens,
    // query arguments or extra business records. Ordinary responses are unchanged.
    const diagnostics = session.role === 'ADMIN' && new URL(_request.url).searchParams.get('timing') === '1'
      ? { milliseconds: { ...timing, total: Date.now() - started } } : undefined;
    return NextResponse.json({ owner: session.owner, item, ...(diagnostics ? { diagnostics } : {}) }, { headers });
  } catch { return NextResponse.json({ error: "INVENTORY_UNAVAILABLE" }, { status: 503, headers }); }
}

/** Native clients use the same BELLO save action as the Web editor. No direct ZAICO calls. */
async function save(request: Request, context: { params: Promise<{ id: string }> }, creating: boolean | "delete") {
  const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
  const { id } = await context.params;
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
    if (creating === "delete") {
      const body = raw as { id?: unknown; expectedUpdatedAt?: unknown } | null;
      if (!body || Array.isArray(body) || body.id !== id || !/^[a-f0-9-]{36}$/i.test(id) ||
          typeof body.expectedUpdatedAt !== "string" || !Number.isFinite(Date.parse(body.expectedUpdatedAt)) ||
          Object.keys(body).some(key => !["id", "expectedUpdatedAt"].includes(key))) return fail("INVALID_INPUT", 422);
      await deleteInventory(id, { skipRedirect: true, expectedUpdatedAt: body.expectedUpdatedAt });
      if (await getInventoryDetail(id)) return fail("UNCONFIRMED", 503);
      return NextResponse.json({ owner: session.owner, deletedId: id }, { headers });
    }
    const body = parseMobileSave(raw, id);
    if (Boolean(body.create) !== creating) return fail("INVALID_INPUT", 422);
    const row = await getInventoryDetail(body.id);
    if (!row && !creating) return fail("NOT_FOUND", 404);
    if (row && creating && !mobileWriteWasApplied(row, body, session.owner)) return fail("CONFLICT", 409);
    // A previous response may have been lost. Confirm the receipt before attempting a write.
    if (!row || !mobileWriteWasApplied(row, body, session.owner)) {
      const source = body.copyFrom ? await getInventoryDetail(body.copyFrom.id) : null;
      if (body.copyFrom && !source) return fail("CONFLICT", 409);
      const [categories, locations, statuses] = await Promise.all([listCategories(row?.categoryId ?? source?.categoryId), listLocations(row?.locationId ?? source?.locationId), listStatuses()]);
      const assets = source ? await listInventoryPhotoAssetsAction(source.id) : null;
      if (source && (!assets?.ok || assets.value.truncated)) return fail("COPY_IMAGES_UNAVAILABLE", 422);
      const input = row ? mobileInventoryInput(row, body, session.owner, session.features, categories, locations, statuses) : source
        ? mobileCopyInput(source, assets?.ok ? assets.value.assets : [], process.env.PHOTO_REGISTRATION_BUCKET_NAME, body, session.owner, session.features, categories, locations, statuses)
        : mobileCreateInput(body, session.owner, session.features, categories, locations, statuses);
      try {
        if (creating) await createInventory(input, { skipRedirect: true, id: body.id });
        else await updateInventory(body.id, input, { skipRedirect: true });
      }
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
    if (error instanceof InventoryMutationRejected) return fail(error.code,422);
    if (error instanceof MobileWriteValidationError) return fail(error.code, error.code === "FIELD_FORBIDDEN" ? 403 : 422);
    if (error instanceof InventorySaveError && error.code === "CONFLICT") return fail("CONFLICT", 409);
    // A failure after submission is not proof that the data was not saved.
    return fail("UNCONFIRMED", 503);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) { return save(request, context, false); }
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { return save(request, context, true); }
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) { return save(request, context, "delete"); }
