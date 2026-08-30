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
import { extractGraphQLOperationName } from "@/lib/listing/mercari/client";
import { PRODUCT_CATEGORIES_QUERY } from "@/lib/listing/mercari/queries";
import { isEcListingEligible, buildCategoryNameLookup, EXCLUDED_CATEGORY_NAMES } from "@/lib/listing/ecEligibility";
import { calculateFloorPrice, calculateMarkdownPrice, calculateNextPriceActionAt, evaluatePricingSafety, type PricingRuleRecord } from "@/lib/listing/pricing";

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
  assertEqual(internalStatusToMercariApiStatus("PUBLISHING"), "PUBLISHED", "productStatus mapper: PUBLISHING -> PUBLISHED");
  assertEqual(internalStatusToMercariApiStatus("ACTIVE"), "PUBLISHED", "productStatus mapper: ACTIVE -> PUBLISHED");
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
    firstListedAt: null,
    lastListedAt: null,
    lastRelistedAt: null,
    endedAt: null,
    soldAt: null,
    lastError: null,
    autoPricingEnabled: false,
    pricingRuleId: null,
    originalPrice: null,
    currentPrice: null,
    floorPrice: null,
    markdownCount: 0,
    lastPriceChangeAt: null,
    nextPriceActionAt: null,
    automationHold: false,
    lastAutomationResult: null,
    shippingRank: null,
    shippingDestinationPrefecture: null,
    calculatedShippingFee: null,
    confirmedShippingFee: null,
    shippingFeeUpdatedAt: null,
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
    firstListedAt: null,
    lastListedAt: null,
    lastRelistedAt: null,
    endedAt: null,
    soldAt: null,
    lastError: null,
    autoPricingEnabled: false,
    pricingRuleId: null,
    originalPrice: null,
    currentPrice: null,
    floorPrice: null,
    markdownCount: 0,
    lastPriceChangeAt: null,
    nextPriceActionAt: null,
    automationHold: false,
    lastAutomationResult: null,
    shippingRank: null,
    shippingDestinationPrefecture: null,
    calculatedShippingFee: null,
    confirmedShippingFee: null,
    shippingFeeUpdatedAt: null,
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

// ── BELLO統合業務OS指示書(2026-08-30) §12/§94: EC出品対象外カテゴリー
// (lib/listing/ecEligibility.ts)。 ──────────────────────────────────────

function testEcListingEligibility() {
  assertEqual(EXCLUDED_CATEGORY_NAMES.length, 6, "EXCLUDED_CATEGORY_NAMES: exactly the 6 categories named in the spec");
  for (const name of EXCLUDED_CATEGORY_NAMES) {
    assertTrue(!isEcListingEligible(name), `isEcListingEligible: "${name}" is excluded`);
  }
  assertTrue(isEcListingEligible("販売中"), "isEcListingEligible: an ordinary category is eligible");
  assertTrue(isEcListingEligible(null), "isEcListingEligible: no category set is not itself a reason to exclude (other required-field checks handle that separately)");
  // 正規化(NFKC/trim/空白畳み込み/大文字小文字無視)が効くことの確認 —
  // masterSeed.tsが実際に投入する値と表記ゆれがあっても除外漏れしない。
  assertTrue(!isEcListingEligible("　破棄　"), "isEcListingEligible: normalizes full-width spaces/whitespace before comparing");

  const lookup = buildCategoryNameLookup([
    { id: "cat-1", name: "破棄" },
    { id: "cat-2", name: "販売中" },
  ]);
  assertEqual(lookup("cat-1"), "破棄", "buildCategoryNameLookup: resolves a known categoryId to its name");
  assertEqual(lookup("cat-2"), "販売中", "buildCategoryNameLookup: resolves a different categoryId independently");
  assertEqual(lookup("cat-unknown"), null, "buildCategoryNameLookup: an unknown categoryId resolves to null, not a crash");
  assertEqual(lookup(null), null, "buildCategoryNameLookup: no categoryId resolves to null");
  assertTrue(!isEcListingEligible(lookup("cat-1")), "isEcListingEligible + buildCategoryNameLookup compose: an excluded category's id is correctly rejected end-to-end");
}

// ── BELLO統合業務OS指示書(2026-08-30) §17-19: Pricing Rule Engine
// (lib/listing/pricing.ts)。 ────────────────────────────────────────────

const BASE_RULE: PricingRuleRecord = {
  id: "rule-1",
  name: "テストルール",
  enabled: true,
  channel: "MERCARI_SHOPS",
  startAfterDays: 7,
  intervalDays: 5,
  markdownType: "PERCENTAGE",
  markdownValue: 10,
  floorPriceMode: "PERCENTAGE_OF_ORIGINAL",
  floorPriceValue: 50,
  maxExecutions: 3,
  relistEnabled: false,
  relistAfterDays: null,
  actionAtFloor: "PAUSE",
};

function testPricingCalculations() {
  assertEqual(calculateFloorPrice(10000, { floorPriceMode: "FIXED_AMOUNT", floorPriceValue: 3000 }), 3000, "calculateFloorPrice: FIXED_AMOUNT returns the value as-is");
  assertEqual(
    calculateFloorPrice(10000, { floorPriceMode: "PERCENTAGE_OF_ORIGINAL", floorPriceValue: 50 }),
    5000,
    "calculateFloorPrice: PERCENTAGE_OF_ORIGINAL computes a percentage of the original price",
  );
  assertEqual(
    calculateFloorPrice(9999, { floorPriceMode: "PERCENTAGE_OF_ORIGINAL", floorPriceValue: 33 }),
    3300,
    "calculateFloorPrice: rounds UP (ceil) so the floor is never accidentally undercut by rounding",
  );

  assertEqual(calculateMarkdownPrice(10000, { markdownType: "FIXED_AMOUNT", markdownValue: 1000 }, 0), 9000, "calculateMarkdownPrice: FIXED_AMOUNT subtracts a flat amount");
  assertEqual(calculateMarkdownPrice(10000, { markdownType: "PERCENTAGE", markdownValue: 10 }, 0), 9000, "calculateMarkdownPrice: PERCENTAGE subtracts a percentage of current price");
  assertEqual(
    calculateMarkdownPrice(5100, { markdownType: "PERCENTAGE", markdownValue: 10 }, 5000),
    5000,
    "calculateMarkdownPrice: clamps at the floor price rather than going below it",
  );

  const firstListedAt = new Date("2026-01-01T00:00:00.000Z");
  assertEqual(
    calculateNextPriceActionAt(BASE_RULE, firstListedAt, null).toISOString(),
    "2026-01-08T00:00:00.000Z",
    "calculateNextPriceActionAt: first markdown is firstListedAt + startAfterDays",
  );
  const lastChange = new Date("2026-01-08T00:00:00.000Z");
  assertEqual(
    calculateNextPriceActionAt(BASE_RULE, firstListedAt, lastChange).toISOString(),
    "2026-01-13T00:00:00.000Z",
    "calculateNextPriceActionAt: subsequent markdowns use lastPriceChangeAt + intervalDays, not startAfterDays again",
  );
}

function testPricingSafety() {
  const base = {
    status: "ACTIVE" as const,
    quantity: 3,
    autoPricingEnabled: true,
    automationHold: false,
    externalListingId: "ext-1",
    currentPrice: 8000,
    floorPrice: 5000,
    markdownCount: 1,
    rule: BASE_RULE,
    nextPriceActionAt: new Date("2026-01-01T00:00:00.000Z"),
    now: new Date("2026-01-02T00:00:00.000Z"),
  };

  assertEqual(evaluatePricingSafety(base), { safe: true }, "evaluatePricingSafety: all conditions satisfied is safe");

  assertEqual(evaluatePricingSafety({ ...base, status: "SOLD" }), { safe: false, reason: "STATUS_NOT_ELIGIBLE" }, "evaluatePricingSafety: SOLD blocks automation");
  assertEqual(evaluatePricingSafety({ ...base, status: "ENDED" }), { safe: false, reason: "STATUS_NOT_ELIGIBLE" }, "evaluatePricingSafety: ENDED blocks automation");
  assertEqual(evaluatePricingSafety({ ...base, status: "ARCHIVED" }), { safe: false, reason: "STATUS_NOT_ELIGIBLE" }, "evaluatePricingSafety: ARCHIVED blocks automation");
  assertEqual(evaluatePricingSafety({ ...base, quantity: 0 }), { safe: false, reason: "OUT_OF_STOCK" }, "evaluatePricingSafety: zero stock blocks automation");
  assertEqual(evaluatePricingSafety({ ...base, autoPricingEnabled: false }), { safe: false, reason: "AUTO_PRICING_DISABLED" }, "evaluatePricingSafety: per-listing opt-in must be on (default OFF per §161)");
  assertEqual(evaluatePricingSafety({ ...base, automationHold: true }), { safe: false, reason: "AUTOMATION_ON_HOLD" }, "evaluatePricingSafety: a manual hold blocks automation even if otherwise enabled");
  assertEqual(evaluatePricingSafety({ ...base, externalListingId: null }), { safe: false, reason: "NO_EXTERNAL_LISTING" }, "evaluatePricingSafety: no external listing yet blocks automation");
  assertEqual(evaluatePricingSafety({ ...base, rule: null }), { safe: false, reason: "RULE_MISSING" }, "evaluatePricingSafety: no assigned rule blocks automation");
  assertEqual(evaluatePricingSafety({ ...base, rule: { ...BASE_RULE, enabled: false } }), { safe: false, reason: "RULE_DISABLED" }, "evaluatePricingSafety: a disabled rule blocks automation");
  assertEqual(
    evaluatePricingSafety({ ...base, markdownCount: 3 }),
    { safe: false, reason: "MAX_EXECUTIONS_REACHED" },
    "evaluatePricingSafety: reaching maxExecutions blocks further automation",
  );
  assertEqual(evaluatePricingSafety({ ...base, currentPrice: 5000, floorPrice: 5000 }), { safe: false, reason: "AT_FLOOR_PRICE" }, "evaluatePricingSafety: already at the floor blocks further markdown");
  assertEqual(
    evaluatePricingSafety({ ...base, nextPriceActionAt: new Date("2026-06-01T00:00:00.000Z") }),
    { safe: false, reason: "NOT_DUE_YET" },
    "evaluatePricingSafety: not yet due blocks a premature markdown",
  );
}

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
  // 不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §4での再調査
  // (WebSearch、複数回一貫して同じ内容を確認)で、Mercari Shops API
  // 公式ドキュメントに「未登録のIPアドレスからのリクエストは404を返す」
  // と明記されていることが判明した——以前はUNKNOWN_REMOTE_ERROR
  // (「推測で決めつけない」ための暫定分類)だったが、今回の裏付けにより
  // IP_NOT_ALLOWEDへ正しく分類するよう更新した(docs/
  // mercari-404-root-cause-20260830.md参照)。
  assertEqual(classifyHttpStatus(404), "IP_NOT_ALLOWED", "classifyHttpStatus: 404 -> IP_NOT_ALLOWED(公式ドキュメントに「未登録IPは404を返す」と明記されていることを2026-08-30に再調査・確認)");

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
  assertTrue(!isRetryableMercariErrorCode("IP_NOT_ALLOWED"), "isRetryableMercariErrorCode: IP_NOT_ALLOWED is not retryable(未登録IPは再試行しても直らない)");

  const err = new MercariApiError("AUTH_FAILED", "HTTP 401: invalid token");
  assertEqual(err.code, "AUTH_FAILED", "MercariApiError: exposes the classified code");
  assertTrue(err.message.includes("認証に失敗"), "MercariApiError: user-facing message uses the Japanese category label");
  assertTrue(err.causeMessage.includes("HTTP 401"), "MercariApiError: technical detail is kept separately in causeMessage");

  const ipErr = new MercariApiError("IP_NOT_ALLOWED", "HTTP 404: Not Found");
  assertTrue(ipErr.message.includes("固定IPアドレスの事前登録"), "MercariApiError(IP_NOT_ALLOWED): user-facing message gives actionable guidance, not a generic 'unknown error'");

  assertEqual(extractGraphQLOperationName(PRODUCT_CATEGORIES_QUERY), "ProductCategories", "extractGraphQLOperationName: extracts the operation name from a real query used by this codebase");
  assertEqual(extractGraphQLOperationName("mutation CreateProduct($input: CreateProductInput!) { createProduct(input: $input) { id } }"), "CreateProduct", "extractGraphQLOperationName: works for mutations too");
  assertEqual(extractGraphQLOperationName("{ productCategories { id } }"), "unknown", "extractGraphQLOperationName: an anonymous query falls back to 'unknown' rather than throwing");
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
  testEcListingEligibility();
  testPricingCalculations();
  testPricingSafety();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("verify-listing.ts crashed:", err);
  process.exit(1);
});
