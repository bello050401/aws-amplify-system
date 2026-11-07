import { NextRequest, NextResponse } from "next/server";
import { verifyLineSignature } from "@/lib/messaging/line/signature";
import { getLineChannelSecret } from "@/lib/messaging/line/tokenAccess";
import { enqueueInquiry } from "@/lib/inquiry/runtime/store";
import type { LineWebhookBody } from "@/lib/messaging/line/types";
import { scopeKey } from "@/lib/inquiry/runtime/policy";
import {
  isWithdrawn,
  markWithdrawn,
} from "@/lib/inquiry/runtime/withdrawalState";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  const raw = await request.text();
  if (Buffer.byteLength(raw) > 1_000_000)
    return new NextResponse(null, { status: 413 });
  const secret = await getLineChannelSecret();
  if (!secret)
    return new NextResponse("LINE integration not configured", { status: 503 });
  if (
    !verifyLineSignature(raw, request.headers.get("x-line-signature"), secret)
  )
    return new NextResponse("Invalid signature", { status: 401 });
  let body: LineWebhookBody;
  try {
    body = JSON.parse(raw);
    if (
      !body ||
      typeof body.destination !== "string" ||
      !Array.isArray(body.events) ||
      body.events.length > 100
    )
      throw Error();
  } catch {
    return new NextResponse("Invalid body", { status: 400 });
  }
  let failed = 0;
  for (const event of body.events) {
    if (
      event.source?.type !== "user" ||
      !event.source.userId ||
      !["message", "unsend"].includes(event.type)
    )
      continue;
    if (
      !event.webhookEventId ||
      !Number.isSafeInteger(event.timestamp) ||
      !(event.message?.id || event.unsend?.messageId)
    ) {
      failed++;
      continue;
    }
    // Do not persist reply credentials or untrusted attachment download URLs.
    const safeEvent = {
      type: event.type,
      webhookEventId: event.webhookEventId,
      timestamp: event.timestamp,
      source: { type: "user", userId: event.source.userId },
      ...(event.unsend
        ? { unsend: { messageId: event.unsend.messageId } }
        : {}),
      ...(event.message
        ? {
            message: {
              id: event.message.id,
              type: event.message.type,
              text: event.message.text,
              quotedMessageId: event.message.quotedMessageId,
              contentProvider: event.message.contentProvider
                ? { type: event.message.contentProvider.type }
                : undefined,
            },
          }
        : {}),
    };
    try {
      const pk = scopeKey("LINE", body.destination, event.source.userId);
      if (event.type === "unsend" && event.unsend)
        await markWithdrawn(pk, event.unsend.messageId);
      if (
        event.type === "message" &&
        event.message &&
        (await isWithdrawn(pk, event.message.id))
      )
        continue;
      await enqueueInquiry(
        "LINE",
        body.destination,
        event.source.userId,
        event.webhookEventId,
        { channel: "LINE", account: body.destination, event: safeEvent },
      );
    } catch {
      failed++;
    }
  }
  return NextResponse.json(
    { ok: failed === 0, failed },
    { status: failed ? 503 : 200, headers: { "Cache-Control": "no-store" } },
  );
}
