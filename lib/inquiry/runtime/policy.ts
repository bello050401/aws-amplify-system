import { createHash } from "node:crypto";

export const INQUIRY_VERSION = "2026-11-07.1";
export const DEBOUNCE_MS = 5_000,
  MAX_BATCH_WAIT_MS = 15_000,
  LEASE_MS = 180_000;
export type InquiryResultState =
  | "ANSWERABLE"
  | "CUSTOMER_CONFIRMATION"
  | "STAFF_CONFIRMATION"
  | "TECHNICAL_BLOCK";
export const RESULT_LABELS: Record<InquiryResultState, string> = {
  ANSWERABLE: "回答可能",
  CUSTOMER_CONFIRMATION: "お客様への確認が必要",
  STAFF_CONFIRMATION: "社員の確認が必要",
  TECHNICAL_BLOCK: "接続・処理の確認が必要",
};
export function scopeKey(
  channel: string,
  account: string,
  conversation: string,
) {
  if (!channel || !account || !conversation)
    throw Error("受信元を確認できません。");
  return (
    "CONV#" +
    createHash("sha256")
      .update(JSON.stringify([channel, account, conversation]))
      .digest("hex")
  );
}
export function eventKey(id: string) {
  return "EVENT#" + createHash("sha256").update(id).digest("hex");
}
export function nextDue(first: number, last: number) {
  return Math.min(first + MAX_BATCH_WAIT_MS, last + DEBOUNCE_MS);
}
/** Provider activity orders the inbox; receipt time is only for debounce/leases. */
export function inquiryActivityAt(value: string | number | undefined, previous: number | undefined, now: number) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  const incoming = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, now) : now;
  return Math.max(Number.isFinite(previous) ? Math.min(previous!, now) : 0, incoming);
}
export function conversationStamp(
  c: {
    lastIncomingAt?: string | null;
    lastOutgoingAt?: string | null;
    workflowStatus?: string | null;
  },
  messages: readonly {
    id: string;
    direction: string;
    body: string;
    deliveryStatus: string;
    updatedAt?: string;
  }[],
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        c.lastIncomingAt,
        c.lastOutgoingAt,
        c.workflowStatus,
        messages
          .map((m) => [
            m.id,
            m.direction,
            m.body,
            m.deliveryStatus,
            m.updatedAt,
          ])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ]),
    )
    .digest("hex");
}
/** Research workers cannot turn a page instruction into a write operation. */
export function researchBudget(
  input: { startedAt: number; actions: number; failures: number },
  now = Date.now(),
) {
  return {
    allowed:
      now - input.startedAt < 180_000 &&
      input.actions < 30 &&
      input.failures < 2,
    remainingActions: Math.max(0, 30 - input.actions),
    remainingMs: Math.max(0, 180_000 - (now - input.startedAt)),
  };
}
