/**
 * BELLO統合改修 master指示書 Phase D: standalone verification for the
 * EC Listing integration's pure business logic (channel-override
 * resolution, EC eligibility, pricing rules, manual-listing text),
 * mirroring scripts/verify-zaico-sync.ts's approach (no test framework
 * installed in this repo).
 *
 * Run with: npm run verify:listing
 *
 * 2026-09-14指示書「Mercariは商品情報・文章・画像の準備と手動出品支援を
 * 基本とする」対応でMercari Shops API出品機能を撤去したため、旧
 * lib/listing/mercari/{mapper/*,adapter,client,errors,queries,endpoints}
 * への依存(mapper変換・adapter検証・User-Agent整形・エラー分類の検証)は
 * ここから削除した — それらのモジュールは撤去済みで、対応する検証対象が
 * 存在しない。条件コード(condition)の共通表示は
 * lib/listing/conditionOptions.ts (旧mapper/condition.tsから移設)経由で
 * 引き続き使う(testManualListingText参照)。
 */
import { conditionLabel } from "@/lib/listing/conditionOptions";
import { resolveEffectiveListingFields, type ChannelListingRecord, type ListingDraftRecord } from "@/lib/listing/types";
import { isEcListingEligible, buildCategoryNameLookup, EXCLUDED_CATEGORY_NAMES } from "@/lib/listing/ecEligibility";
import { assertExternalWriteAllowed, isExternalWriteEnabled, listEnabledExternalWrites, ExternalWriteBlockedError } from "@/lib/integrations/writeGuard";
import { calculateFloorPrice, calculateMarkdownPrice, calculateNextPriceActionAt, decideActionAtFloor,
  evaluatePricingSafety, type PricingRuleRecord } from "@/lib/listing/pricing";
import { buildManualListingText } from "@/lib/listing/manualListingText";

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

// ── lib/listing/types.ts's Channel Override resolution ─────────────────

function testResolveEffectiveListingFields() {
  const draft: ListingDraftRecord = {
    id: "draft-1",
    inventoryId: "inv-1",
    title: "共通タイトル",
    description: "共通説明文",
    price: 5000,
    condition: "NO_NOTABLE_DAMAGE",
    shippingMethod: "KAZAI" as const,
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

function testActionAtFloor() {
  // この4択は以前どれを選んでも挙動が同じだった(判定側がactionAtFloorを
  // 一度も読んでいなかった)。選択肢ごとに実際に違う結果になることを固定する。
  const atFloor = { status: "QUEUED", automationHold: false };

  const keep = decideActionAtFloor("KEEP", atFloor);
  assertTrue(keep.status === undefined && keep.automationHold === undefined, "decideActionAtFloor: KEEPは状態を変えない");
  assertTrue(keep.note.length > 0, "decideActionAtFloor: KEEPでも理由は記録する");

  const pause = decideActionAtFloor("PAUSE", atFloor);
  assertEqual(pause.status, "PAUSED", "decideActionAtFloor: PAUSEは出品を停止する");
  assertTrue(pause.automationHold === undefined, "decideActionAtFloor: PAUSEはholdを立てない");

  const review = decideActionAtFloor("MANUAL_REVIEW", atFloor);
  assertEqual(review.automationHold, true, "decideActionAtFloor: MANUAL_REVIEWは手動確認待ちにする");
  assertTrue(review.status === undefined, "decideActionAtFloor: MANUAL_REVIEWは出品を停止しない");

  const relist = decideActionAtFloor("RELIST", atFloor);
  assertTrue(relist.status === undefined && relist.automationHold === undefined, "decideActionAtFloor: RELISTは未実装なので何も変更しない");
  assertTrue(relist.note.includes("未実装"), "decideActionAtFloor: RELISTは未実装であることを記録に残す");

  // 4択が互いに区別できること(全部同じ結果に戻る退行を防ぐ)
  const notes = new Set([keep.note, pause.note, review.note, relist.note]);
  assertEqual(notes.size, 4, "decideActionAtFloor: 4つの選択肢がそれぞれ異なる結果になる");

  // 冪等性 — 既に停止済み/確認待ちなら重ねて書かない
  const alreadyPaused = decideActionAtFloor("PAUSE", { status: "PAUSED", automationHold: false });
  assertTrue(alreadyPaused.status === undefined, "decideActionAtFloor: 既にPAUSEDなら再度停止しない");
  const alreadyHeld = decideActionAtFloor("MANUAL_REVIEW", { status: "QUEUED", automationHold: true });
  assertTrue(alreadyHeld.automationHold === undefined, "decideActionAtFloor: 既に確認待ちなら重ねて立てない");
}

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

/**
 * 外部サービスへの書き込み禁止スイッチ。
 *
 * このスイッチが守っているのは「設定を忘れたときに、書き込めてしまう
 * 側に倒れない」という一点なので、**未設定・空・変な値のときに禁止に
 * なること**を最も丁寧に固定する。実運用で開ける判断をするまで、
 * pricing-scheduler Lambda（1時間ごとに無人で走る）を含めて、
 * どの経路からもBASE/Mercariの実データが変わらないことの根拠になる。
 */
function testExternalWriteGuard() {
  // 既定は禁止。ここが崩れると、他のすべての防御が意味を失う。
  assertEqual(listEnabledExternalWrites({}), [], "writeGuard: 環境変数が未設定なら何も許可しない");
  assertEqual(listEnabledExternalWrites({ EXTERNAL_WRITES_ENABLED: "" }), [], "writeGuard: 空文字は許可しない");
  assertEqual(listEnabledExternalWrites({ EXTERNAL_WRITES_ENABLED: "   " }), [], "writeGuard: 空白だけは許可しない");
  assertEqual(isExternalWriteEnabled("BASE", {}), false, "writeGuard: 未設定ならBASEは禁止");
  assertEqual(isExternalWriteEnabled("MERCARI_SHOPS", {}), false, "writeGuard: 未設定ならMercariは禁止");

  // 「全部オン」を一語で書けないこと —— スイッチの意味が失われるため。
  assertEqual(listEnabledExternalWrites({ EXTERNAL_WRITES_ENABLED: "ALL" }), [], "writeGuard: ALL では許可しない（チャネル名を明示させる）");
  assertEqual(listEnabledExternalWrites({ EXTERNAL_WRITES_ENABLED: "true" }), [], "writeGuard: true では許可しない");
  assertEqual(listEnabledExternalWrites({ EXTERNAL_WRITES_ENABLED: "1" }), [], "writeGuard: 1 では許可しない");
  assertEqual(listEnabledExternalWrites({ EXTERNAL_WRITES_ENABLED: "ZAICO" }), [], "writeGuard: 知らない名前は無視する");

  // 明示的に名前を書いたときだけ、そのチャネルだけが開く。
  assertEqual(listEnabledExternalWrites({ EXTERNAL_WRITES_ENABLED: "BASE" }), ["BASE"], "writeGuard: BASEだけを許可できる");
  assertEqual(
    isExternalWriteEnabled("MERCARI_SHOPS", { EXTERNAL_WRITES_ENABLED: "BASE" }),
    false,
    "writeGuard: BASEを開けてもMercariは閉じたまま（片方ずつ開けられる）",
  );
  assertEqual(
    listEnabledExternalWrites({ EXTERNAL_WRITES_ENABLED: " base , mercari_shops " }),
    ["BASE", "MERCARI_SHOPS"],
    "writeGuard: 前後の空白と大文字小文字は吸収する",
  );
  assertEqual(
    listEnabledExternalWrites({ EXTERNAL_WRITES_ENABLED: "BASE,UNKNOWN,MERCARI_SHOPS" }),
    ["BASE", "MERCARI_SHOPS"],
    "writeGuard: 知らない名前が混ざっても、正しい名前は生きる",
  );

  // 関門は「投げる」こと。戻り値で伝えると呼び出し側が無視できてしまう。
  let thrown: unknown = null;
  try {
    assertExternalWriteAllowed("BASE", "items/edit", {});
  } catch (err) {
    thrown = err;
  }
  assertEqual(thrown instanceof ExternalWriteBlockedError, true, "writeGuard: 禁止時は例外になる（黙って素通りしない）");
  assertEqual((thrown as ExternalWriteBlockedError).channel, "BASE", "writeGuard: どのチャネルが止まったかを保持する");
  assertEqual((thrown as ExternalWriteBlockedError).operation, "items/edit", "writeGuard: 何をしようとしたかを保持する");
  assertEqual(
    (thrown as Error).message.includes("EXTERNAL_WRITES_ENABLED"),
    true,
    "writeGuard: 解除方法がメッセージから分かる",
  );

  let threw2 = false;
  try {
    assertExternalWriteAllowed("BASE", "items/add", { EXTERNAL_WRITES_ENABLED: "BASE" });
  } catch {
    threw2 = true;
  }
  assertEqual(threw2, false, "writeGuard: 許可されていれば通す");
}

/**
 * 2026-09-14指示書「Mercariは商品情報・文章・画像の準備と手動出品支援を
 * 基本とする」対応 — lib/listing/manualListingText.tsのbuildManualListingText。
 * 外部へは何も送信しない純関数(clipboardへコピーする文字列を組み立てる
 * だけ)なので、内容がそのまま固定できる。
 */
function testManualListingText() {
  const full = buildManualListingText({
    title: "テスト商品",
    description: "説明文です。",
    price: 12000,
    condition: "NO_NOTABLE_DAMAGE",
    categoryName: "家具",
  });
  assertTrue(full.includes("【タイトル】\nテスト商品"), "manualListingText: タイトルを含める");
  assertTrue(full.includes("¥12,000"), "manualListingText: 価格を3桁区切りで含める");
  assertTrue(full.includes(conditionLabel("NO_NOTABLE_DAMAGE")), "manualListingText: コンディションのラベルを含める(コード直書きにしない)");
  assertTrue(full.includes("【カテゴリー】\n家具"), "manualListingText: カテゴリー名があれば含める");
  assertTrue(full.includes("【説明文】\n説明文です。"), "manualListingText: 説明文を含める");

  const empty = buildManualListingText({ title: "", description: "", price: null, condition: "NO_NOTABLE_DAMAGE", categoryName: null });
  assertTrue(empty.includes("（未入力）"), "manualListingText: 空欄は「（未入力）」と明示する(空文字を黙って出さない)");
  assertTrue(!empty.includes("【カテゴリー】"), "manualListingText: カテゴリー未設定ならセクション自体を出さない");
}

async function main() {
  testResolveEffectiveListingFields();
  testEcListingEligibility();
  testPricingCalculations();
  testPricingSafety();
  testActionAtFloor();
  testExternalWriteGuard();
  testManualListingText();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("verify-listing.ts crashed:", err);
  process.exit(1);
});
