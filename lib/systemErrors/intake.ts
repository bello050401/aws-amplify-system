import { normalizeSystemErrorSignal } from "./contract";
import type { SystemErrorQueue } from "./queue";
import { isOutboundRequestOriginAllowed } from '../outbound/requestOrigin';
export type ErrorReporterAccess = {kind: string; owner?: string | null};

export async function handleSystemErrorPost(request: Request, dependencies: {
  access: () => Promise<ErrorReporterAccess>;
  queue: () => SystemErrorQueue | null;
  publicOrigin?: string;
}): Promise<Response> {
  const json = (body: unknown, status: number) => Response.json(body, {status, headers: {"Cache-Control": "no-store"}});
  const origin = request.headers.get("origin");
  try {
    const native = !origin && request.headers.get('x-bello-mobile') === '1' && !request.headers.has('sec-fetch-site');
    if ((!native && !isOutboundRequestOriginAllowed(request, dependencies.publicOrigin)) || request.headers.get("x-bello-error-report") !== "1") return json({error: "FORBIDDEN"}, 403);
  } catch { return json({error: "FORBIDDEN"}, 403); }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({error: "JSON_REQUIRED"}, 415);
  let access: ErrorReporterAccess;
  try {access = await dependencies.access();} catch {return json({error:'AUTH_UNAVAILABLE'},503);}
  if (access.kind === "temporarily-unavailable") return json({error: "AUTH_UNAVAILABLE"}, 503);
  if (access.kind !== "authorized" || !access.owner) return json({error: "UNAUTHORIZED"}, 401);
  if (Number(request.headers.get("content-length")) > 4096) return json({error: "TOO_LARGE"}, 413);
  let data: unknown;
  try {
    const reader = request.body?.getReader();
    if (!reader) return json({error: "INVALID_SIGNAL"}, 400);
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 4096) {await reader.cancel(); return json({error: "TOO_LARGE"}, 413);}
      chunks.push(part.value);
    }
    data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { return json({error: "INVALID_SIGNAL"}, 400); }
  const safe = normalizeSystemErrorSignal(data);
  if (!safe) return json({error: "INVALID_SIGNAL"}, 400);
  const queue = dependencies.queue();
  if (!queue) return json({accepted: false, reason: "NOT_CONFIGURED"}, 503);
  try {await queue.enqueue(safe, access.owner); return json({accepted: true}, 202);}
  catch {return json({accepted: false, reason: "QUEUE_UNAVAILABLE"}, 503);}
}
