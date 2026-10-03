import { NextResponse, type NextRequest } from "next/server";
import { getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { existingReadDispatchForOwner } from "@/lib/listing/mercariBridge/httpContract";
import { mercariBridgeReadRepository, mercariBridgeResultRepository } from "@/lib/listing/mercariBridge/repository";
import { acceptExistingReadResult, ResultAcceptanceError } from "@/lib/listing/mercariBridge/resultAcceptance";

export const dynamic = "force-dynamic";
const MAX_BODY = 16000;
const noStore = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const reply = (body: Record<string, unknown>, status: number) =>
  NextResponse.json(body, { status, headers: noStore });
const requestIdFrom = (request: NextRequest) => {
  const value = request.nextUrl.searchParams.get("requestId");
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
};

async function ownedDispatch(request: NextRequest) {
  const requestId = requestIdFrom(request);
  if (!requestId || request.headers.get("x-bello-mercari-bridge") !== "READ_EXISTING") return null;
  if (await getInventoryRole() !== "ADMIN") return null;
  const principal = await getCurrentInventoryUserEmail();
  if (!principal) return null;
  const job = await mercariBridgeReadRepository.getJob(requestId);
  if (!job) return null;
  const binding = await mercariBridgeReadRepository.getBinding(job.inventoryId);
  return existingReadDispatchForOwner(job, binding, principal);
}

/** Uses the same Cognito ADMIN browser session as BELLO. No anonymous/device shared-key route. */
export async function GET(request: NextRequest) {
  if (process.env.NEXT_ENGINE_ISOLATED_APP === "1") return reply({ ok: false }, 404);
  try {
    const dispatch = await ownedDispatch(request);
    return dispatch ? reply({ ok: true, job: dispatch }, 200) : reply({ ok: false }, 403);
  } catch { return reply({ ok: false }, 503); }
}

/** A same-origin, authenticated ADMIN POST stores only bounded comparison codes. */
export async function POST(request: NextRequest) {
  if (process.env.NEXT_ENGINE_ISOLATED_APP === "1") return reply({ ok: false }, 404);
  if (request.headers.get("origin") !== request.nextUrl.origin ||
      !request.headers.get("content-type")?.startsWith("application/json") ||
      request.headers.has("next-action")) return reply({ ok: false }, 403);
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY))
    return reply({ ok: false }, 413);
  let dispatch;
  try { dispatch = await ownedDispatch(request); }
  catch { return reply({ ok: false }, 503); }
  if (!dispatch) return reply({ ok: false }, 403);
  let raw: unknown;
  try {
    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > MAX_BODY) return reply({ ok: false }, 413);
    raw = JSON.parse(body);
  } catch { return reply({ ok: false }, 400); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      (raw as Record<string, unknown>).requestId !== dispatch.requestId) return reply({ ok: false }, 400);
  try {
    const saved = await acceptExistingReadResult(raw, mercariBridgeResultRepository);
    return reply({ ok: true, stored: true, requestId: saved.requestId,
      attemptId: saved.attemptId, readStatus: saved.status, listingConfirmed: false }, 200);
  } catch (error) {
    if (error instanceof ResultAcceptanceError) {
      return reply({ ok: false, code: error.code }, error.code === "STORAGE_UNAVAILABLE" ? 503 : 409);
    }
    return reply({ ok: false }, 503);
  }
}
