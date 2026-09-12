/**
 * task_9f1355050200ca9a64: 商品紹介の実サービス境界検証。
 *
 * 6b842f9(task_a6b2b54e57b190ec79)が追加した3つの機械検査
 *   - カテゴリ矛盾(findCategoryMismatchViolations / stripCategoryMismatchSentences)
 *   - 製造国の未確認主張(checkFactSafetyのUNSUPPORTED_COUNTRY_CLAIM)
 *   - コンディション混入(既存 findIntroConditionViolations との組み合わせ回帰)
 * は、いずれも独自のverify-intro-validator.ts(validator82件)・
 * verify-product-intro.ts(intro192件)という「関数を直接呼ぶ」単体テスト
 * でしか確認されていなかった。実際に商品ページを作る経路は
 * lib/ai/productPage/service.ts の generateProductPage() であり、
 *   - プロンプト構築(buildProductPageSystemPrompt/buildProductPageUserPrompt)
 *   - AIの構造化応答(generateStructured経由のtoolUse)
 *   - 書き直しループ(MAX_ATTEMPTS=2)
 *   - 書き直し後の文単位の除去(stripXxxSentences)
 *   - 最終文面へのcheckFactSafety
 * を一本の関数として実行して初めて、3つの検査が「実際に出力へ反映されるか」
 * が確認できる。ここではその generateProductPage() を一切書き換えずに
 * 実行し、外部境界(AIプロバイダ・AIUsageLog書き込み)だけを合成応答に
 * 差し替える —— scripts/verify-ai-gateway-recording.ts が確立した手法
 * (node:module registerHooksでlib/ai/gateway/gateway.tsの相対importだけを
 * リダイレクトする)をそのまま流用する。実Anthropic/Bedrock/Nova SDKへの
 * ネットワーク呼び出しは一切発生せず、DynamoDB(AIUsageLog)への書き込みも
 * 発生しない。在庫データは完全な合成値(実顧客データ・実在庫は使わない)。
 *
 * Run with: npm run verify:product-page-service-boundary (依存ゼロ・node単体で動く)
 */
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

declare module "node:module" {
  export function registerHooks(hooks: {
    resolve?: (specifier: string, context: { parentURL?: string }, nextResolve: (specifier: string, context: unknown) => unknown) => unknown;
  }): void;
}

const projectRoot = pathToFileURL(process.cwd() + "/").href;
const mocksDir = pathToFileURL(process.cwd() + "/scripts/__mocks__/").href;
const PROVIDER_MOCK_URL = mocksDir + "aiGateway.provider.mock.mjs";
const USAGE_LOG_MOCK_URL = mocksDir + "aiGateway.usageLog.mock.mjs";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: "data:text/javascript,export default {}", shortCircuit: true };
    }
    // gateway.ts からの相対importだけを差し替える(verify-ai-gateway-recording.ts
    // と同じ境界)。generateProductPage()自身・prompt.ts・introValidator.ts・
    // factSafety.ts・facts.ts はすべて本物のまま実行する。
    if (context.parentURL?.endsWith("/lib/ai/gateway/gateway.ts")) {
      if (specifier === "./anthropicProvider") return { url: PROVIDER_MOCK_URL, shortCircuit: true };
      if (specifier === "./bedrockProvider") return { url: PROVIDER_MOCK_URL, shortCircuit: true };
      if (specifier === "./novaProvider") return { url: PROVIDER_MOCK_URL, shortCircuit: true };
      if (specifier === "./usageLog") return { url: USAGE_LOG_MOCK_URL, shortCircuit: true };
    }
    const target = specifier.startsWith("@/") ? projectRoot + specifier.slice(2) : specifier;
    try {
      return nextResolve(target, context);
    } catch {
      return nextResolve(target + ".ts", context);
    }
  },
});

process.env.AI_GATEWAY_PROVIDER = "nova";
delete process.env.ANTHROPIC_API_KEY;

const { generateProductPage } = await import("@/lib/ai/productPage/service");
const providerMock = await import(PROVIDER_MOCK_URL);
const usageLogMock = await import(USAGE_LOG_MOCK_URL);

type Sections = {
  title: string;
  introduction: string;
  brandSection: string;
  designerSection: string;
  featureSection: string;
  materialSection: string;
  dimensionsSection: string;
  conditionSection: string;
  shippingSection: string;
};

function sections(introduction: string, overrides: Partial<Sections> = {}): Sections {
  return {
    title: "ヤマギワ テーブルランプ",
    introduction,
    brandSection: "",
    designerSection: "",
    featureSection: "",
    materialSection: "",
    dimensionsSection: "",
    conditionSection: "",
    shippingSection: "",
    ...overrides,
  };
}

/** __configure に渡す1回分の応答(providerMockの契約: outputはJSON文字列)。 */
function step(s: Sections) {
  return { output: JSON.stringify(s) };
}

let passes = 0;
let failures = 0;
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

function resetMocks() {
  usageLogMock.__reset();
}

/** 合成(架空)在庫。実顧客データ・実在庫は一切使わない。 */
const LIGHTING_INPUT_BASE = {
  inventoryId: "synthetic-lighting-001",
  name: "ヤマギワ テーブルランプ サンプルモデル",
  categoryName: "照明",
  width: "20",
  depth: "20",
  height: "45",
  damageNotes: null,
  note: null,
  conditionRating: null,
  stockQuantity: 3,
  sku: "SYN-LIGHT-001",
  archive: [],
  styleProfile: null,
  styleProfileVersion: null,
  brand: "ヤマギワ",
};

// ── ① カテゴリ矛盾: 1回目で違反、2回目で自発的に直る ──────────────────
async function testCategoryMismatchFixedOnRetry() {
  resetMocks();
  providerMock.__configure([
    step(sections("ヤマギワのテーブルランプです。デザイナーズ家具としても知られるシリーズで、灯りをともすと空間の印象が大きく変わります。傘にはすりガラスを使用しています。")),
    step(sections("ヤマギワのテーブルランプです。灯りをともすと空間の印象が大きく変わる、存在感のある一台です。傘にはすりガラスを使用しており、点灯時にはやわらかな光が広がります。")),
  ]);

  const result = await generateProductPage({ ...LIGHTING_INPUT_BASE });

  assertEqual(providerMock.__callCount(), 2, "①カテゴリ矛盾→2回目で修正: AI呼び出しは2回(再試行1回分)");
  assertTrue(!!result.sections && !result.sections.introduction.includes("家具"), "①カテゴリ矛盾→2回目で修正: 最終紹介文に「家具」が残らない");
  assertEqual(result.introSanitized, false, "①カテゴリ矛盾→2回目で修正: 機械的な文除去はしていない(モデル自身が直した)");
  assertTrue(result.ok, "①カテゴリ矛盾→2回目で修正: 最終的にok");
  assertEqual((result.violations ?? []).map((v) => v.code), [], "①カテゴリ矛盾→2回目で修正: violationsは0件");
}

// ── ② カテゴリ矛盾: 2回とも違反だが、文単位の除去で成立する ────────────
async function testCategoryMismatchStrippedAfterBothAttemptsFail() {
  resetMocks();
  const bad = sections(
    "ヤマギワのテーブルランプです。デザイナーズ家具としても人気のシリーズです。" +
      "存在感のある美しいフォルムが、灯りをともすと空間の印象を変えます。" +
      "傘の部分にはすりガラスが使われており、点灯時には柔らかく拡散した光が広がります。書斎の机上でも、寝室のサイドテーブルの上でも収まりの良いサイズです。",
  );
  providerMock.__configure([step(bad), step(bad)]);

  const result = await generateProductPage({ ...LIGHTING_INPUT_BASE });

  assertEqual(providerMock.__callCount(), 2, "②カテゴリ矛盾→両回とも違反: AI呼び出しは2回(上限どおり、追加呼出なし)");
  assertTrue(!!result.sections && !result.sections.introduction.includes("家具"), "②カテゴリ矛盾→両回とも違反: 除去後の紹介文に「家具」が残らない");
  assertEqual(result.introSanitized, true, "②カテゴリ矛盾→両回とも違反: 機械的に文を除去して採用した");
  assertTrue(result.ok, "②カテゴリ矛盾→両回とも違反: 除去後は成立してok");
}

// ── ③ カテゴリ矛盾: 除去しても紹介文として成立しない場合は失敗として返す ──
async function testCategoryMismatchFailsWhenUnstrippable() {
  resetMocks();
  // 全文が「家具」の話に終始しており、文単位で落とすと80字未満になる。
  const allBad = sections("ヤマギワのテーブルランプです。デザイナーズ家具として知られています。家具好きに人気の家具シリーズです。");
  providerMock.__configure([step(allBad), step(allBad)]);

  const result = await generateProductPage({ ...LIGHTING_INPUT_BASE });

  assertEqual(providerMock.__callCount(), 2, "③カテゴリ矛盾→除去不能: AI呼び出しは2回(失敗時も追加呼出なし)");
  assertTrue(!result.ok, "③カテゴリ矛盾→除去不能: 黙って通さずokはfalse");
  assertTrue(
    (result.violations ?? []).some((v) => v.code === "INTRO_CATEGORY_MISMATCH"),
    "③カテゴリ矛盾→除去不能: INTRO_CATEGORY_MISMATCHとして報告する",
  );
  assertTrue(!!result.failureReason, "③カテゴリ矛盾→除去不能: failureReasonが埋まる(捏造で誤魔化さない)");
}

// ── ④ 製造国: 部材(脚)の製造国だけの事実から、完成品全体の製造国を
//     主張したら不合格になる(retryでは直らず、最終checkFactSafetyで検出) ──
async function testCountryClaimFromPartOnlyFactIsRejected() {
  resetMocks();
  const sofaInput = {
    inventoryId: "synthetic-sofa-001",
    name: "サンプル ラウンジソファ",
    categoryName: "ソファ",
    width: "180",
    depth: "85",
    height: "70",
    damageNotes: null,
    note: "脚はイタリア製です。", // 部材(脚)だけの製造国 —— 完成品全体の裏付けにはならない
    conditionRating: null,
    stockQuantity: 2,
    sku: "SYN-SOFA-001",
    archive: [],
    styleProfile: null,
    styleProfileVersion: null,
    brand: null,
  };
  providerMock.__configure([
    step(sections("落ち着いた雰囲気のラウンジソファです。このソファはイタリア製で、贅沢な座り心地が魅力です。", { title: "サンプル ラウンジソファ" })),
  ]);

  const result = await generateProductPage(sofaInput);

  assertEqual(providerMock.__callCount(), 1, "④国主張(部材根拠のみ)→不合格: 寸法/コンディション/カテゴリは問題ないため1回で確定する(国主張は書き直しの対象ではない)");
  assertTrue(!result.ok, "④国主張(部材根拠のみ)→不合格: 完成品全体のイタリア製主張は不合格");
  assertTrue(
    (result.violations ?? []).some((v) => v.code === "UNSUPPORTED_COUNTRY_CLAIM"),
    "④国主張(部材根拠のみ)→不合格: UNSUPPORTED_COUNTRY_CLAIMとして報告する",
  );
  assertTrue(!!result.fullDescription, "④国主張(部材根拠のみ)→不合格: 不合格でも本文は捏造せず組み立てて返す(監査・修正用)");
}

// ── ⑤ 製造国: 完成品そのものの製造国が事実として明示されていれば合格する ──
async function testCountryClaimGroundedByWholeProductFactPasses() {
  resetMocks();
  const sofaInput = {
    inventoryId: "synthetic-sofa-002",
    name: "サンプル ラウンジソファ2",
    categoryName: "ソファ",
    width: "180",
    depth: "85",
    height: "70",
    damageNotes: null,
    note: "このソファはイタリア製です。", // 完成品そのものの製造国が明示されている
    conditionRating: null,
    stockQuantity: 2,
    sku: "SYN-SOFA-002",
    archive: [],
    styleProfile: null,
    styleProfileVersion: null,
    brand: null,
  };
  providerMock.__configure([
    step(sections("落ち着いた雰囲気のラウンジソファです。このソファはイタリア製で、贅沢な座り心地が魅力です。", { title: "サンプル ラウンジソファ2" })),
  ]);

  const result = await generateProductPage(sofaInput);

  assertEqual(providerMock.__callCount(), 1, "⑤国主張(完成品根拠あり)→合格: 1回で確定する");
  assertTrue(
    !(result.violations ?? []).some((v) => v.code === "UNSUPPORTED_COUNTRY_CLAIM"),
    "⑤国主張(完成品根拠あり)→合格: UNSUPPORTED_COUNTRY_CLAIMにならない",
  );
}

// ── ⑥ コンディション混入の既存回帰: カテゴリ矛盾検査を追加しても、
//     従来のコンディション書き直しループは壊れていない ─────────────────
async function testConditionLeakStillRewrittenAfterCategoryCheckAdded() {
  resetMocks();
  const chairInput = {
    inventoryId: "synthetic-chair-001",
    name: "サンプル ラウンジチェア",
    categoryName: "チェア",
    width: "70",
    depth: "75",
    height: "80",
    damageNotes: "座面に若干のスレがあります。",
    note: null,
    conditionRating: null,
    stockQuantity: 1,
    sku: "SYN-CHAIR-001",
    archive: [],
    styleProfile: null,
    styleProfileVersion: null,
    brand: null,
  };
  providerMock.__configure([
    step(sections("ゆとりのある座り心地が魅力のラウンジチェアです。座面には若干のスレが見られますが、使用に支障はありません。", { title: "サンプル ラウンジチェア" })),
    step(sections("ゆとりのある座り心地が魅力のラウンジチェアです。丸みのあるフォルムがリビングにも書斎にもなじみます。", { title: "サンプル ラウンジチェア" })),
  ]);

  const result = await generateProductPage(chairInput);

  assertEqual(providerMock.__callCount(), 2, "⑥コンディション混入の既存回帰: 2回目で直るまで書き直す");
  assertTrue(!!result.sections && !result.sections.introduction.includes("スレ"), "⑥コンディション混入の既存回帰: 最終紹介文にコンディション語が残らない");
  assertTrue(result.ok, "⑥コンディション混入の既存回帰: 最終的にok");
}

// ── ⑦ AIUsageLogへの実書き込みが起きていないこと(境界確認そのもの) ──────
async function testNoRealUsageLogWrite() {
  resetMocks();
  providerMock.__configure([step(sections("落ち着いた雰囲気の合成テスト用ソファです。事実の範囲だけで書かれています。"))]);
  await generateProductPage({
    inventoryId: "synthetic-boundary-001",
    name: "サンプル 境界確認ソファ",
    categoryName: "ソファ",
    width: "180",
    depth: "85",
    height: "70",
    damageNotes: null,
    note: null,
    conditionRating: null,
    stockQuantity: 1,
    sku: "SYN-BOUND-001",
    archive: [],
    styleProfile: null,
    styleProfileVersion: null,
    brand: null,
  });
  // usageLogMock.callsは「実DynamoDBの代わりに」recordAIUsageの入力を
  // 積んでいるだけの配列 —— ここに1件積まれていることが、実書き込みでは
  // なく合成境界を通ったことの直接の証拠になる。
  assertEqual(usageLogMock.calls.length, 1, "⑦AIUsageLog境界: 実DynamoDBではなく合成モックへ1件記録される(実書き込みなし)");
}

async function main() {
  await testCategoryMismatchFixedOnRetry();
  await testCategoryMismatchStrippedAfterBothAttemptsFail();
  await testCategoryMismatchFailsWhenUnstrippable();
  await testCountryClaimFromPartOnlyFactIsRejected();
  await testCountryClaimGroundedByWholeProductFactPasses();
  await testConditionLeakStillRewrittenAfterCategoryCheckAdded();
  await testNoRealUsageLogWrite();

  console.log(`\n${passes} passed, ${failures} failed`);
  console.log(
    "\n[未確認事項] 本テストは外部AI応答を完全合成したものであり、実Anthropic/Bedrock/Nova応答の" +
      "実際の言い回し傾向(例: どの程度の頻度でカテゴリ矛盾/国主張が起きるか)は未確認。" +
      "実プロバイダとの疎通・実データでの再現率はscripts/evaluate-product-pages.ts(実DynamoDB+実AI、" +
      "課金・本番接続を伴うため本タスクでは実行していない)側の役割。",
  );
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
