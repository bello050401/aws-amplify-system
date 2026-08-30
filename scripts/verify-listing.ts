/**
 * BELLO統合改修 master指示書 Phase D: standalone verification for the
 * EC Listing / Mercari Shops integration's pure business logic (mapper
 * functions + validation), mirroring scripts/verify-zaico-sync.ts's
 * approach (no test framework installed in this repo).
 *
 * Run with: npm run verify:listing
 * (goes through scripts/with-server-only-stub.cjs — lib/listing/mercari/
 * adapter.ts and its dependencies are `server-only`.)
 */
import { LISTING_CONDITIONS, conditionLabel, conditionToMercariValue } from "@/lib/listing/mercari/mapper/condition";
import { SHIPPING_PAYERS, shippingPayerLabel, shippingPayerToMercariValue } from "@/lib/listing/mercari/mapper/shippingPayer";
import { SHIPPING_DURATIONS, shippingDurationLabel, shippingDurationToMercariValue } from "@/lib/listing/mercari/mapper/shippingDuration";
import { internalStatusToMercariApiStatus } from "@/lib/listing/mercari/mapper/productStatus";
import { resolveEffectiveListingFields, type ChannelListingRecord, type ListingDraftRecord } from "@/lib/listing/types";
import { createMercariProduct } from "@/lib/listing/mercari/adapter";
import { formatMercariUserAgent } from "@/lib/listing/mercari/endpoints";
import { MercariApiError, classifyHttpStatus, classifyForbiddenError, classifyGraphQLErrors, isRetryableMercariErrorCode } from "@/lib/listing/mercari/errors";

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

async function assertRejects(fn: () => Promise<unknown>, messageSubstring: string, label: string) {
  try {
    await fn();
    failures++;
    console.error(`✗ FAIL ${label}\n    expected a rejection containing "${messageSubstring}", but it resolved`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes(messageSubstring)) {
      passes++;
      console.log(`✓ ${label}`);
    } else {
      failures++;
      console.error(`✗ FAIL ${label}\n    expected message to include "${messageSubstring}"\n    actual:   ${message}`);
    }
  }
}

// ── Mappers — ported near-verbatim from origin/claude/
// mercari-shops-auto-listing-ag0w6m's own test suite (condition.test.ts/
// shippingPayer.test.ts/shippingDuration.test.ts), adapted to this
// script's plain assert helpers instead of vitest. ─────────────────────

function testConditionMapper() {
  assertEqual(LISTING_CONDITIONS.length, 6, "condition mapper: covers all 6 condition levels");
  assertEqual(conditionLabel("NO_NOTABLE_DAMAGE"), "目立った傷や汚れなし", "condition mapper: returns the Japanese label for a known code");
  assertEqual(conditionToMercariValue("SLIGHT_DAMAGE"), "SLIGHT_DAMAGE", "condition mapper: returns a Mercari API value for a known code");
  assertTrue(
    LISTING_CONDITIONS.every((c) => c.label.length > 0 && c.mercariValue.length > 0),
    "condition mapper: every entry has a non-empty label and mercariValue",
  );
}

function testShippingPayerMapper() {
  assertEqual(SHIPPING_PAYERS.map((p) => p.code), ["SELLER", "BUYER"], "shippingPayer mapper: covers SELLER and BUYER");
  assertEqual(shippingPayerLabel("SELLER"), "送料込み（出品者負担）", "shippingPayer mapper: labels SELLER");
  assertEqual(shippingPayerLabel("BUYER"), "着払い（購入者負担）", "shippingPayer mapper: labels BUYER");
  assertEqual(shippingPayerToMercariValue("BUYER"), "BUYER", "shippingPayer mapper: maps to a Mercari API value");
}

function testShippingDurationMapper() {
  assertEqual(SHIPPING_DURATIONS.length, 4, "shippingDuration mapper: covers the 4 durations from the spec");
  assertEqual(SHIPPING_DURATIONS.map((d) => d.label), ["1〜2日", "2〜3日", "4〜7日", "8日以上"], "shippingDuration mapper: exact label set");
  assertEqual(shippingDurationLabel("UNKNOWN"), "UNKNOWN", "shippingDuration mapper: falls back to the raw code when a label is unknown");
  let threw = false;
  try {
    shippingDurationToMercariValue("UNKNOWN");
  } catch {
    threw = true;
  }
  assertTrue(threw, "shippingDuration mapper: throws on an unknown code instead of silently mapping it");
}

function testProductStatusMapper() {
  assertEqual(internalStatusToMercariApiStatus("QUEUED"), "PUBLISHED", "productStatus mapper: QUEUED -> PUBLISHED");
  assertEqual(internalStatusToMercariApiStatus("LISTED"), "PUBLISHED", "productStatus mapper: LISTED -> PUBLISHED");
  assertEqual(internalStatusToMercariApiStatus("DRAFT"), "PUBLISHED", "productStatus mapper: DRAFT falls back to PUBLISHED (send-on-attempt default)");
}

// ── lib/listing/types.ts's Channel Override resolution ─────────────────

function testResolveEffectiveListingFields() {
  const draft: ListingDraftRecord = {
    id: "draft-1",
    inventoryId: "inv-1",
    title: "共通タイトル",
    description: "共通説明文",
    price: 5000,
    condition: "NO_NOTABLE_DAMAGE",
    images: [{ storageKey: "inventory/a.jpg", sortOrder: 0 }],
    createdBy: null,
    updatedBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const baseChannelListing: ChannelListingRecord = {
    id: "cl-1",
    listingDraftId: "draft-1",
    inventoryId: "inv-1",
    channel: "MERCARI_SHOPS",
    categoryMapping: { mercariCategoryId: "cat-1" },
    overrideTitle: null,
    overrideDescription: null,
    overridePrice: null,
    status: "DRAFT",
    externalListingId: null,
    listingUrl: null,
    listedAt: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const noOverrides = resolveEffectiveListingFields(draft, baseChannelListing);
  assertEqual(noOverrides, { title: "共通タイトル", description: "共通説明文", price: 5000 }, "Channel Override: no overrides falls back to the common draft entirely");

  const withOverrides = resolveEffectiveListingFields(draft, { ...baseChannelListing, overrideTitle: "Mercari用タイトル", overridePrice: 4500 });
  assertEqual(
    withOverrides,
    { title: "Mercari用タイトル", description: "共通説明文", price: 4500 },
    "Channel Override: only the fields actually overridden change, the rest still comes from the common draft",
  );
}

// ── Adapter-level validation (createMercariProduct) — these checks run
// before any network/AWS call, so they're safely testable without a live
// backend; a validation failure here would otherwise only surface deep
// inside a real Mercari API round-trip. ────────────────────────────────

async function testAdapterValidation() {
  const draft: ListingDraftRecord = {
    id: "draft-1",
    inventoryId: "inv-1",
    title: "テスト商品",
    description: "説明",
    price: 3000,
    condition: "NEW",
    images: [],
    createdBy: null,
    updatedBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const channelListing: ChannelListingRecord = {
    id: "cl-1",
    listingDraftId: "draft-1",
    inventoryId: "inv-1",
    channel: "MERCARI_SHOPS",
    categoryMapping: null,
    overrideTitle: null,
    overrideDescription: null,
    overridePrice: null,
    status: "DRAFT",
    externalListingId: null,
    listingUrl: null,
    listedAt: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  await assertRejects(
    () => createMercariProduct({ draft, channelListing, shippingPayer: "SELLER", inventoryQuantity: 1 }),
    "カテゴリー",
    "adapter validation: refuses to list without a Mercari category mapping",
  );

  const withCategory = { ...channelListing, categoryMapping: { mercariCategoryId: "cat-1" } };

  await assertRejects(
    () => createMercariProduct({ draft, channelListing: withCategory, shippingPayer: "SELLER", inventoryQuantity: 1 }),
    "画像",
    "adapter validation: refuses to list with zero images",
  );

  const draftWithImage = { ...draft, images: [{ storageKey: "inventory/a.jpg", sortOrder: 0 }] };

  // BELLO統合改修 master指示書(2026-08-29統合改修版) §17-A:
  // コンディション未設定は黙ってフォールバックせずCONFIG_REQUIREDとして
  // ブロックする(以前はNO_NOTABLE_DAMAGEへ黙って倒していた)。
  await assertRejects(
    () => createMercariProduct({ draft: { ...draftWithImage, condition: null }, channelListing: withCategory, shippingPayer: "SELLER", inventoryQuantity: 1 }),
    "コンディション",
    "adapter validation: refuses to list without a condition selected, instead of silently defaulting one",
  );

  // §17-A: variantのquantityはInventory実在庫数量から導出必須 — 0以下
  // (在庫切れ)はブロックする。
  await assertRejects(
    () => createMercariProduct({ draft: draftWithImage, channelListing: withCategory, shippingPayer: "SELLER", inventoryQuantity: 0 }),
    "在庫数量",
    "adapter validation: refuses to list when the current Inventory quantity is 0",
  );
}

// ── BELLO統合改修 master指示書(2026-08-29統合改修版) §7/§17根本修正:
// 実際に報告されたHTTP 404の根本原因調査で判明した必須User-Agent
// ヘッダ。フォーマット自体(lib/listing/mercari/endpoints.tsの
// formatMercariUserAgent)は副作用の無い純関数としてテストする —
// 実際にどこから値を取得するか(Secrets Manager優先・環境変数フォール
// バック、lib/listing/mercari/tokenAccess.tsのgetMercariUserAgent/
// getMercariClientNameConfig)はAWSへ実際に触れるため、このアプリの
// 他のAWS接続コード(getMercariAccessToken等)と同じ理由でここでは
// ユニットテストしない — 接続確認画面での実際の保存・検証フロー経由
// でのみ検証される。 ───────────────────────────────────────────────

function testFormatMercariUserAgent() {
  assertEqual(formatMercariUserAgent("bello-inventory", "1.2.3"), "bello-inventory/1.2.3", "formatMercariUserAgent: joins clientName/version with a slash");
  assertEqual(formatMercariUserAgent("bello-inventory"), "bello-inventory/0.0.0", "formatMercariUserAgent: defaults version to 0.0.0 per Mercari's own documented convention when omitted");
}

// ── BELLO統合業務OS指示書(2026-08-30) §29/§90: Mercariエラー分類
// (lib/listing/mercari/errors.ts)。 ─────────────────────────────────────

function testMercariErrorClassification() {
  assertEqual(classifyHttpStatus(401), "AUTH_FAILED", "classifyHttpStatus: 401 -> AUTH_FAILED");
  assertEqual(classifyHttpStatus(403), "AUTH_FAILED", "classifyHttpStatus: 403 defaults to AUTH_FAILED (classifyForbiddenError refines further)");
  assertEqual(classifyHttpStatus(429), "RATE_LIMITED", "classifyHttpStatus: 429 -> RATE_LIMITED");
  assertEqual(classifyHttpStatus(500), "UNKNOWN_REMOTE_ERROR", "classifyHttpStatus: 5xx -> UNKNOWN_REMOTE_ERROR (retryable)");
  assertEqual(classifyHttpStatus(404), "UNKNOWN_REMOTE_ERROR", "classifyHttpStatus: 404 (the historically-reported bug) falls back to UNKNOWN_REMOTE_ERROR, not a guessed specific cause");

  assertEqual(classifyForbiddenError("Access denied: IP address not allowed"), "IP_NOT_ALLOWED", "classifyForbiddenError: recognizes an IP-restriction message");
  assertEqual(classifyForbiddenError("Forbidden"), "AUTH_FAILED", "classifyForbiddenError: a generic 403 without IP wording stays AUTH_FAILED");

  assertEqual(classifyGraphQLErrors([{ message: "Unauthenticated request" }]), "AUTH_FAILED", "classifyGraphQLErrors: recognizes an auth-related message");
  assertEqual(
    classifyGraphQLErrors([{ message: "bad request", extensions: { code: "RATE_LIMITED" } }]),
    "RATE_LIMITED",
    "classifyGraphQLErrors: reads extensions.code when present",
  );
  assertEqual(classifyGraphQLErrors([{ message: "price must be a positive integer" }]), "REMOTE_VALIDATION_ERROR", "classifyGraphQLErrors: an ordinary input error defaults to REMOTE_VALIDATION_ERROR");

  assertTrue(isRetryableMercariErrorCode("RATE_LIMITED"), "isRetryableMercariErrorCode: RATE_LIMITED is retryable");
  assertTrue(isRetryableMercariErrorCode("NETWORK_ERROR"), "isRetryableMercariErrorCode: NETWORK_ERROR is retryable");
  assertTrue(!isRetryableMercariErrorCode("CONFIG_REQUIRED"), "isRetryableMercariErrorCode: CONFIG_REQUIRED is not retryable (retrying can't fix missing config)");
  assertTrue(!isRetryableMercariErrorCode("AUTH_FAILED"), "isRetryableMercariErrorCode: AUTH_FAILED is not retryable");

  const err = new MercariApiError("AUTH_FAILED", "HTTP 401: invalid token");
  assertEqual(err.code, "AUTH_FAILED", "MercariApiError: exposes the classified code");
  assertTrue(err.message.includes("認証に失敗"), "MercariApiError: user-facing message uses the Japanese category label");
  assertTrue(err.causeMessage.includes("HTTP 401"), "MercariApiError: technical detail is kept separately in causeMessage");
}

async function main() {
  testConditionMapper();
  testShippingPayerMapper();
  testShippingDurationMapper();
  testProductStatusMapper();
  testResolveEffectiveListingFields();
  await testAdapterValidation();
  testFormatMercariUserAgent();
  testMercariErrorClassification();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("verify-listing.ts crashed:", err);
  process.exit(1);
});
