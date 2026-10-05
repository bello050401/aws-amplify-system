import { NextResponse, type NextRequest } from "next/server";
import { getCurrentInventoryUserSub, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { getInventoryDetail } from "@/lib/inventory/queries";
import { bridgePostHeaderFailure } from "@/lib/listing/mercariBridge/postGuard";
import { privateCreateTrialEnabled } from "@/lib/listing/mercariBridge/privateCreateGate";
import { privateCreateEventRepository } from "@/lib/listing/mercariBridge/privateCreateRepository";
import { acceptPrivateCreateTrialEvent, PINNED_PRIVATE_CREATE_TARGET,
  privateCreateTrialForOwner, PrivateCreateTrialError } from
  "@/lib/listing/mercariBridge/privateCreateTrial";

export const dynamic = "force-dynamic";
const MAX_BODY = 2048;
const noStore = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const reply = (body: Record<string, unknown>, status: number) =>
  NextResponse.json(body, { status, headers: noStore });
const enabled = () => privateCreateTrialEnabled(
  process.env.MERCARI_PRIVATE_CREATE_TRIAL_ENABLED,
  process.env.MERCARI_BRIDGE_PUBLIC_ORIGIN);

async function principal(request: NextRequest) {
  if (request.headers.get("x-bello-mercari-bridge") !== "PRIVATE_CREATE_TRIAL" ||
      await getInventoryRole() !== "ADMIN") return null;
  return getCurrentInventoryUserSub();
}

/** Owner-only status. Nothing here is a ChannelListing or a Shops HTTP receipt. */
export async function GET(request: NextRequest) {
  if (!enabled()) return reply({ ok: false }, 404);
  try {
    const owner = await principal(request);
    if (!owner) return reply({ ok: false }, 403);
    return reply({ ok: true, ...(await privateCreateTrialForOwner(owner,
      privateCreateEventRepository)) }, 200);
  } catch (error) {
    if (error instanceof PrivateCreateTrialError)
      return reply({ ok: false }, error.code === "OWNER_REQUIRED" ? 403 :
        error.code === "EVENT_CONFLICT" ? 409 : 503);
    return reply({ ok: false }, 503);
  }
}

/** Import one locally claimed/recorded event. No Shops request is made. */
export async function POST(request: NextRequest) {
  if (!enabled()) return reply({ ok: false }, 404);
  const headerFailure = bridgePostHeaderFailure({
    origin: request.headers.get("origin"), requestOrigin: request.nextUrl.origin,
    configuredPublicOrigin: process.env.MERCARI_BRIDGE_PUBLIC_ORIGIN,
    contentType: request.headers.get("content-type"),
    hasNextAction: request.headers.has("next-action"),
  });
  if (headerFailure) return reply({ ok: false, code: headerFailure }, 403);
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY))
    return reply({ ok: false }, 413);
  let owner: string | null;
  try { owner = await principal(request); }
  catch { return reply({ ok: false }, 503); }
  if (!owner) return reply({ ok: false, code: "OWNER_REQUIRED" }, 403);
  let raw: unknown;
  try {
    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > MAX_BODY) return reply({ ok: false }, 413);
    raw = JSON.parse(body);
  } catch { return reply({ ok: false }, 400); }
  try {
    if ((raw as { kind?: unknown })?.kind === "BELLO_PRIVATE_CREATE_CLAIM") {
      const inventory = await getInventoryDetail(PINNED_PRIVATE_CREATE_TARGET.inventoryId);
      if (!inventory || inventory.sku !== PINNED_PRIVATE_CREATE_TARGET.inventoryCode)
        return reply({ ok: false, code: "TARGET_UNAVAILABLE" }, 409);
    }
    const saved = await acceptPrivateCreateTrialEvent(raw, owner,
      privateCreateEventRepository);
    return reply({ ok: true, stored: true, attemptId: saved.attemptId,
      status: saved.status, listingConfirmed: false }, 200);
  } catch (error) {
    if (error instanceof PrivateCreateTrialError)
      return reply({ ok: false, code: error.code },
        error.code === "INVALID_INPUT" ? 400 :
          error.code === "STORAGE_UNAVAILABLE" ? 503 : 409);
    return reply({ ok: false }, 503);
  }
}
