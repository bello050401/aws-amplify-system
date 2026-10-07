import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { getUrl } from "@aws-amplify/storage/server";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { runWithAmplifyServerContext } from "@/lib/amplify/serverUtils";
import { prepareMercariManualListingPackAction,
  type MercariManualListingPack } from "@/app/actions/mercariManualListingPack";
import { bridgePostHeaderFailure } from "@/lib/listing/mercariBridge/postGuard";

export const dynamic = "force-dynamic";
const MAX_BODY = 65536;
const noStore = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const reply = (body: Record<string, unknown>, status: number) =>
  NextResponse.json(body, { status, headers: noStore });
const canonical = (value: unknown): unknown => Array.isArray(value) ?
  value.map(canonical) : value !== null && typeof value === "object" ?
    Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right)).map(([key, child]) => [key, canonical(child)])) : value;

/** The PC's signed-in BELLO profile rechecks every selected value and image key. */
export async function POST(request: NextRequest) {
  if (process.env.NEXT_ENGINE_ISOLATED_APP === "1") return reply({ ok: false }, 404);
  const headerFailure = bridgePostHeaderFailure({
    origin: request.headers.get("origin"), requestOrigin: request.nextUrl.origin,
    configuredPublicOrigin: process.env.MERCARI_BRIDGE_PUBLIC_ORIGIN,
    contentType: request.headers.get("content-type"),
    hasNextAction: request.headers.has("next-action"),
  });
  if (headerFailure || request.headers.get("x-bello-mercari-bridge") !== "MANUAL_PACK")
    return reply({ ok: false }, 403);
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY))
    return reply({ ok: false }, 413);
  if (await getInventoryRole() !== "ADMIN") return reply({ ok: false }, 403);
  let supplied: MercariManualListingPack;
  try {
    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > MAX_BODY) return reply({ ok: false }, 413);
    supplied = JSON.parse(body) as MercariManualListingPack;
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied))
      return reply({ ok: false }, 400);
  } catch { return reply({ ok: false }, 400); }
  try {
    const current = await prepareMercariManualListingPackAction(supplied.inventoryId, {
      priceYen: supplied.priceYen, quantity: supplied.quantity,
      categoryId: supplied.categoryId, brandId: supplied.brandId,
    });
    if (!current.ok || JSON.stringify(canonical(current.pack)) !==
        JSON.stringify(canonical(supplied)))
      return reply({ ok: false, code: "PACK_CHANGED" }, 409);
    const images = [];
    for (const [index, image] of current.pack.imageRefs.entries()) {
      const { url } = await runWithAmplifyServerContext({
        nextServerContext: { cookies },
        operation: contextSpec => getUrl(contextSpec, {
          path: image.storageKey, options: { expiresIn: 120 },
        }),
      });
      if (url.protocol !== "https:") return reply({ ok: false }, 503);
      images.push({ index, storageKey: image.storageKey, url: url.toString() });
    }
    return reply({ ok: true, inventoryId: current.pack.inventoryId,
      draftId: current.pack.draftId, images }, 200);
  } catch { return reply({ ok: false }, 503); }
}
