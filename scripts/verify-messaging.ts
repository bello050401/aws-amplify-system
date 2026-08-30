/**
 * BELLO統合業務OS指示書(2026-08-30) §38-50: Message coreの純粋ロジック
 * (lib/messaging/conversationStatus.ts)のstandalone verification —
 * scripts/verify-zaico-sync.ts/verify-listing.tsと同じ方針(no test
 * framework installed in this repo)。
 *
 * Run with: npm run verify:messaging
 * (server-onlyなAWS接続コードには触れないため、
 * scripts/with-server-only-stub.cjs経由でなくても動くが、他のverify
 * scriptと呼び出し方を揃えるため同じ経路にしてある。)
 */
import { deriveNeedsReply, deriveConversationStatus, buildMessagePreview, sortConversations } from "@/lib/messaging/conversationStatus";
import type { ConversationRecord } from "@/lib/messaging/types";

let failures = 0;
let passes = 0;

function assertEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ FAIL ${label}\n    expected: ${e}\n    actual:   ${a}`);
  } else {
    passes++;
    console.log(`✓ ${label}`);
  }
}

function assertTrue(cond: boolean, label: string) {
  assertEqual(cond, true, label);
}

function testDeriveNeedsReply() {
  assertTrue(!deriveNeedsReply(null, null), "deriveNeedsReply: no incoming ever -> not needing reply");
  assertTrue(deriveNeedsReply("2026-01-01T00:00:00.000Z", null), "deriveNeedsReply: incoming exists, never replied -> needs reply");
  assertTrue(
    !deriveNeedsReply("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"),
    "deriveNeedsReply: a reply sent after the latest incoming -> REPLIED (not needing reply)",
  );
  assertTrue(
    deriveNeedsReply("2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
    "deriveNeedsReply: a new incoming after the last reply -> needs reply again (§42's exact scenario)",
  );
}

function testDeriveConversationStatus() {
  assertEqual(deriveConversationStatus(false, false, "OPEN"), "OPEN", "deriveConversationStatus: no incoming yet stays OPEN");
  assertEqual(deriveConversationStatus(true, true, "OPEN"), "WAITING_FOR_REPLY", "deriveConversationStatus: needs reply -> WAITING_FOR_REPLY");
  assertEqual(deriveConversationStatus(false, true, "WAITING_FOR_REPLY"), "REPLIED", "deriveConversationStatus: replied -> REPLIED");
  assertEqual(
    deriveConversationStatus(true, true, "RESOLVED"),
    "RESOLVED",
    "deriveConversationStatus: a manually-RESOLVED conversation is never overridden by the timeline calculation",
  );
  assertEqual(deriveConversationStatus(true, true, "ARCHIVED"), "ARCHIVED", "deriveConversationStatus: ARCHIVED is likewise never overridden");
}

function testBuildMessagePreview() {
  assertEqual(buildMessagePreview("こんにちは"), "こんにちは", "buildMessagePreview: a short message is returned as-is");
  assertEqual(buildMessagePreview("行1\n行2\n行3"), "行1 行2 行3", "buildMessagePreview: newlines collapse to spaces for a single-line list row");
  const long = "あ".repeat(100);
  assertEqual(buildMessagePreview(long, 60), `${"あ".repeat(60)}…`, "buildMessagePreview: truncates long bodies with an ellipsis");
}

function testSortConversations() {
  const rows: Pick<ConversationRecord, "needsReply" | "lastMessageAt" | "id">[] = [
    { id: "replied-recent", needsReply: false, lastMessageAt: "2026-01-05T00:00:00.000Z" },
    { id: "needs-reply-old", needsReply: true, lastMessageAt: "2026-01-01T00:00:00.000Z" },
    { id: "needs-reply-new", needsReply: true, lastMessageAt: "2026-01-03T00:00:00.000Z" },
    { id: "replied-old", needsReply: false, lastMessageAt: "2026-01-02T00:00:00.000Z" },
  ];
  const sorted = sortConversations(rows).map((r) => r.id);
  assertEqual(
    sorted,
    ["needs-reply-new", "needs-reply-old", "replied-recent", "replied-old"],
    "sortConversations: needsReply group always comes first (§121 「返信済みが未返信を埋もれさせない」), each group by lastMessageAt desc",
  );

  const tie: Pick<ConversationRecord, "needsReply" | "lastMessageAt" | "id">[] = [
    { id: "b", needsReply: true, lastMessageAt: "2026-01-01T00:00:00.000Z" },
    { id: "a", needsReply: true, lastMessageAt: "2026-01-01T00:00:00.000Z" },
  ];
  assertEqual(sortConversations(tie).map((r) => r.id), ["a", "b"], "sortConversations: an exact tie breaks stably by id");
}

function main() {
  testDeriveNeedsReply();
  testDeriveConversationStatus();
  testBuildMessagePreview();
  testSortConversations();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
