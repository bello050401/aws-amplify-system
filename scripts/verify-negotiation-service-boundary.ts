/**
 * negotiationService.resolveNegotiation(実DynamoDB接続関数を含む)の境界
 * mock試験。前回QAレビューの指摘への対応:
 *
 *   「isApprovedDiscountGroundedの判定を、negotiationServiceが実際に
 *    awaitingDestination=false かつ offer.determined=true を返す合成
 *    ケース(商品価格のみ確定/送料のみ確定/両方確定)で動かし、
 *    customerSafeFactsの中身とisApprovedDiscountGroundedの戻り値を
 *    テストのアサーションとして明示的に確認すること」
 *
 * これまでの verify-inquiry-answer-plan.ts のケース11は、negotiationService
 * のソースコードを読んで「この形のcustomerSafeFactsは値引き後価格が確定
 * した場合にのみ現れる」という契約を**静的に**信じて固定するテストだった。
 * このファイルは、その契約が実装のとおりに成り立っていることを、
 * lib/inquiry/negotiationService.ts の resolveNegotiation を実際に呼び出し
 * て確認する。外部境界(@/lib/shipping/service の listShippingRates /
 * lookupShippingRate。実DynamoDBへ接続する)だけを node:test の
 * モジュールモックで差し替え、それ以外(discount.ts の7%引き計算・地域補正
 * 等)はすべて実関数を通す。実クラウド・実AIへは一切接続しない。
 *
 * Run with: npm run verify:negotiation-service-boundary
 * (Node 22.3+が必要。--experimental-test-module-mocksを使うため、
 *  他のverify:*と違いtsx経由ではなくNode組み込みの型ストリップで実行する
 *  ——理由は scripts/with-server-only-stub-native.cjs のコメント参照)
 *
 * ここで固定したいこと(3つの合成ケース。いずれも配送先は確定済み=
 * awaitingDestination:false):
 *   1. 商品価格のみ確定(配送先の送料レートが引けない) →
 *      offer.determined=false → customerSafeFactsは空 →
 *      isApprovedDiscountGroundedはfalse
 *   2. 送料のみ確定(販売価格が未確定) →
 *      offer.determined=false → customerSafeFactsは空 →
 *      isApprovedDiscountGroundedはfalse
 *   3. 両方確定(販売価格・送料レートとも引ける) →
 *      offer.determined=true → customerSafeFactsに値引き後価格が入る →
 *      isApprovedDiscountGroundedはtrue
 */
import { mock } from "node:test";
import type { ShippingRateRecord } from "@/lib/shipping/types";

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

// ── 外部境界(実DynamoDB接続)だけを差し替える ──────────────────────
//
// resolveNegotiationはこの2関数だけを@/lib/shipping/serviceから使う
// (lib/inquiry/negotiationService.tsのimport文参照)。呼び出しごとに
// currentScenarioを見て返す値を変えることで、シナリオごとにmock.moduleを
// 呼び直さずに済ませる(mock.moduleは同一プロセス内で複数回同じ指定子に
// 適用すると衝突しうるため、1回だけ登録する)。
type Scenario = "PRICE_ONLY" | "SHIPPING_ONLY" | "BOTH";
let currentScenario: Scenario = "BOTH";

const rateRecord: ShippingRateRecord = {
  id: "tokyo-B",
  provider: "アートセッティングデリバリー",
  service: "家財おまかせ便",
  originPrefecture: "埼玉県",
  originArea: null,
  destinationPrefecture: "東京都",
  destinationArea: null,
  rank: "B",
  price: 8000,
  taxIncluded: true,
  currency: "JPY",
  surcharge: null,
  effectiveFrom: null,
  effectiveTo: null,
  sourceReference: null,
  acquiredAt: null,
  verifiedAt: null,
  status: null,
  rawHash: null,
  importBatchId: null,
  version: 1,
  createdBy: null,
  updatedBy: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

mock.module("@/lib/shipping/service", {
  // 実行環境の@types/nodeは`namedExports`のみを型として持つ(新しいNode
  // ランタイムでは`exports`が推奨で`namedExports`は非推奨警告が出るが、
  // 動作に支障は無い。tsc --noEmitを通すため型定義に合わせる)。
  namedExports: {
    listShippingRates: async () => [rateRecord],
    lookupShippingRate: async (prefecture: string, rank: string) => {
      // 「商品価格のみ確定」シナリオは、配送先は分かっているのに料金マスタ
      // にその行が無い(=送料が確定できない)状態を模す。
      if (currentScenario === "PRICE_ONLY") return null;
      if (prefecture === "東京都" && rank === "B") return { price: rateRecord.price!, surcharge: null };
      return null;
    },
  },
});

/**
 * lib/inquiry/pipeline.ts の isApprovedDiscountGrounded と**同じ判定**
 * (`customerSafeFacts.length > 0`)。
 *
 * pipeline.ts を直接importしないのは、pipeline.tsが"next/headers"経由で
 * next.jsのランタイム専用exportsを引き込み、Node組み込みのESMローダー
 * (このファイルの実行方式。--experimental-test-module-mocksを使うために
 * tsxを経由しない。scripts/with-server-only-stub-native.cjs のコメント
 * 参照)では解決できないため(実測:
 * `Cannot find module '.../node_modules/next/headers'`)。この関数と
 * pipeline.tsのisApprovedDiscountGroundedが同じ実装であることは、
 * scripts/verify-inquiry-answer-plan.ts のケース11
 * (testDiscountGroundingIsBasedOnApprovedOfferNotMoneyPresence)が
 * pipeline.ts から直接importして固定している —— ここでの重複は
 * 「実装を作り直す」のではなく、DB境界だけを検証する経路を分離するための
 * 意図的なミラーであることをこのコメントで明示する。
 */
function isApprovedDiscountGrounded(customerSafeFacts: { label: string; value: string }[]): boolean {
  return customerSafeFacts.length > 0;
}

async function main() {
  const { resolveNegotiation } = await import("@/lib/inquiry/negotiationService");

  const negotiationContext = {
    isNegotiation: true,
    signals: ["(合成テスト用の交渉シグナル)"],
    quantity: 1,
    quantityRaw: null,
    requestedTotalPriceYen: 90_000,
    requestedUnitPriceYen: null,
    amounts: [{ yen: 90_000, raw: "9万円" }],
    fromCurrentMessage: true,
  };

  function inventory(unitSalePriceYen: number | null) {
    return {
      inventoryId: "inv-test-1",
      displayInventoryId: "B000001",
      name: "(合成テスト用の椅子)",
      unitSalePriceYen,
      unitSalePriceSource: unitSalePriceYen != null ? ("salePrice" as const) : null,
      purchasePriceYen: 50_000,
      saleStartDate: "2026-08-01",
      width: "50",
      depth: "50",
      height: "80",
    };
  }

  // ── ケース1: 商品価格のみ確定(送料レートが引けない) ────────────────
  currentScenario = "PRICE_ONLY";
  const priceOnly = await resolveNegotiation({
    context: negotiationContext,
    inventory: inventory(100_000),
    destinationPrefecture: "東京都",
    channel: "LINE",
    baseProduct: null,
  });
  assertEqual(priceOnly.evidence.awaitingDestination, false, "商品価格のみ確定: 配送先は確定済み(awaitingDestination=false)");
  assertEqual(priceOnly.customerSafeFacts, [], "商品価格のみ確定: 送料が確定できないためcustomerSafeFactsは空");
  assertEqual(
    isApprovedDiscountGrounded(priceOnly.customerSafeFacts),
    false,
    "商品価格のみ確定: isApprovedDiscountGroundedはfalse(単なる商品価格の確定を値引き根拠にしない)",
  );

  // ── ケース2: 送料のみ確定(販売価格が未確定) ─────────────────────
  currentScenario = "SHIPPING_ONLY";
  const shippingOnly = await resolveNegotiation({
    context: negotiationContext,
    inventory: inventory(null),
    destinationPrefecture: "東京都",
    channel: "LINE",
    baseProduct: null,
  });
  assertEqual(shippingOnly.evidence.awaitingDestination, false, "送料のみ確定: 配送先は確定済み(awaitingDestination=false)");
  assertEqual(shippingOnly.customerSafeFacts, [], "送料のみ確定: 販売価格が未確定のためcustomerSafeFactsは空");
  assertEqual(
    isApprovedDiscountGrounded(shippingOnly.customerSafeFacts),
    false,
    "送料のみ確定: isApprovedDiscountGroundedはfalse(単なる送料の確定を値引き根拠にしない)",
  );

  // ── ケース3: 両方確定(値引き後価格を提示できる) ─────────────────
  currentScenario = "BOTH";
  const both = await resolveNegotiation({
    context: negotiationContext,
    inventory: inventory(100_000),
    destinationPrefecture: "東京都",
    channel: "LINE",
    baseProduct: null,
  });
  assertEqual(both.evidence.awaitingDestination, false, "両方確定: 配送先は確定済み(awaitingDestination=false)");
  assertTrue(both.customerSafeFacts.length > 0, "両方確定: customerSafeFactsに値引き後価格が入る");
  assertTrue(
    both.customerSafeFacts.some((f) => f.label.includes("お値引き後のご提示価格")),
    "両方確定: customerSafeFactsのラベルに値引き後価格であることが明記される",
  );
  assertEqual(
    isApprovedDiscountGrounded(both.customerSafeFacts),
    true,
    "両方確定: isApprovedDiscountGroundedはtrue(negotiationServiceが実際に確定した値引き後価格がある)",
  );

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
