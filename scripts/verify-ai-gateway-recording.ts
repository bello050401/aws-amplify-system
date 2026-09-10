/**
 * task_a5f83718 レビュー補正の結合確認: lib/ai/gateway/gateway.ts の実
 * generateText/generateStructured/getProvider/resolveProviderId、
 * lib/ai/gateway/router.ts の実routeGenerateText/routeGenerateStructured、
 * lib/ai/gateway/qualityGate.ts の実checkTextQuality/checkStructuredQuality
 * — これらは一切書き換えず、そのまま実行する。
 *
 * 差し替える境界は次の2箇所だけ(§3.2の契約どおり、Providerと
 * AIUsageLog書き込みだけがこのGatewayの外部依存):
 *   - ./anthropicProvider / ./bedrockProvider / ./novaProvider
 *     (実Anthropic/Bedrock/Nova SDKへのネットワーク呼び出しの代わりに
 *     fixtureが用意した応答を返す)
 *   - ./usageLog (実DynamoDBへの書き込みの代わりに呼び出し内容を配列に積む)
 *
 * scripts/verify-ai-usage-recording.ts は router.ts だけを対象にした
 * 高速な単体テストで、"lib/ai/gateway/gateway.ts自体はインポートできない
 * (server-onlyや各providerの外部SDK依存のため)"という制約付きだった
 * (task_a5f83718のコメント参照)。この制約を「実装できない理由」にせず、
 * Node 24のmodule.registerHooksでprovider/usageLogの相対importだけを
 * リダイレクトすることで、gateway.tsの実コードを本当に実行して確認する
 * (指示書§4「SDKはQAがnode_modules junctionを準備可能なので環境不足を
 * 理由に模倣実装の試験で代替しない」に対応)。
 *
 * Run with: npm run verify:ai-gateway-recording (依存ゼロ・node単体で動く)
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
    // lib/ai/gateway/gateway.ts からの相対importだけを差し替える —— 他の
    // どの呼び出し元(scripts/verify-ai-gateway.ts等)から見ても本物の
    // anthropicProvider.ts/bedrockProvider.ts/novaProvider.ts/usageLog.ts
    // のまま(salesView.tsのテストと同じ発想)。
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

// resolveProviderId()のデフォルト分岐に依存しない(この環境に
// ANTHROPIC_API_KEYが無い/あるで結果が変わらないようにする) —— 3つの
// provider mockはどれも同じ挙動なので、どれが選ばれても検証内容は同じ。
process.env.AI_GATEWAY_PROVIDER = "nova";
delete process.env.ANTHROPIC_API_KEY;

const gateway = await import("@/lib/ai/gateway/gateway");
const providerMock = await import(PROVIDER_MOCK_URL);
const usageLogMock = await import(USAGE_LOG_MOCK_URL);

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

async function testTextInitialFailThenEscalationPass() {
  usageLogMock.__reset();
  providerMock.__configure([{ output: "" }, { output: "ちゃんとした返信文です。" }], ["economy-model", "premium-model"]);

  const result = await gateway.generateText({
    task: "CUSTOMER_REPLY_DRAFT",
    systemPrompt: "s",
    userPrompt: "u",
    tier: "ECONOMY",
    promptVersion: "test-v1",
  });

  assertTrue(result.fallbackOccurred, "text 初回不合格→次合格: 戻り値のfallbackOccurredはtrue");
  assertTrue(result.qualityGatePassed, "text 初回不合格→次合格: 戻り値のqualityGatePassedはtrue(escalation後)");
  assertEqual(result.output, "ちゃんとした返信文です。", "text 初回不合格→次合格: 戻り値の本文はescalation後のもの");

  assertEqual(usageLogMock.calls.length, 2, "text 初回不合格→次合格: recordAIUsageは2回呼ばれる(初回+escalation、重複なし)");
  const [first, second] = usageLogMock.calls;
  assertEqual(first.success, true, "text 1件目: successはtrue");
  assertEqual(first.result?.modelId, "economy-model", "text 1件目: modelIdはECONOMY側");
  assertEqual(first.result?.qualityGatePassed, false, "text 1件目: recordAIUsageに渡るqualityGatePassedは実際の判定どおりfalse(providerの固定trueではない)");
  assertTrue((first.result?.qualityGateViolations ?? []).some((v: string) => v.startsWith("EMPTY_OUTPUT")), "text 1件目: qualityGateViolationsに実際の不合格理由(EMPTY_OUTPUT)が残る");
  assertEqual(first.result?.fallbackOccurred, false, "text 1件目: fallbackOccurredはfalse(初回分)");
  assertTrue(typeof first.estimatedCostUsd === "number" && first.estimatedCostUsd > 0, "text 1件目: estimatedCostUsdがECONOMY単価で算出されている");

  assertEqual(second.success, true, "text 2件目: successはtrue");
  assertEqual(second.result?.modelId, "premium-model", "text 2件目: modelIdはPREMIUM側");
  assertEqual(second.result?.qualityGatePassed, true, "text 2件目: recordAIUsageに渡るqualityGatePassedはtrue");
  assertEqual(second.result?.qualityGateViolations, [], "text 2件目: qualityGateViolationsは空");
  assertEqual(second.result?.fallbackOccurred, true, "text 2件目: fallbackOccurredはtrue(escalation分、providerの固定falseを流用しない)");
  assertTrue((second.estimatedCostUsd ?? 0) > (first.estimatedCostUsd ?? 0), "text: PREMIUM側のestimatedCostUsdはECONOMY側より高い(モデル別単価が別々に効いている)");
}

async function testStructuredInitialFailThenEscalationPass() {
  usageLogMock.__reset();
  providerMock.__configure([{ output: JSON.stringify({ title: "" }) }, { output: JSON.stringify({ title: "商品A" }) }], ["economy-model", "premium-model"]);

  const toolSchema = { name: "t", description: "d", input_schema: { type: "object" as const, properties: {} } };
  const result = await gateway.generateStructured<{ title: string }>({
    task: "LISTING_TITLE_GENERATION",
    systemPrompt: "s",
    userPrompt: "u",
    toolSchema,
    tier: "ECONOMY",
    promptVersion: "test-v1",
    requiredNonEmptyFields: ["title"],
  });

  assertTrue(result.fallbackOccurred, "structured 初回不合格→次合格: 戻り値のfallbackOccurredはtrue");
  assertEqual(result.output.title, "商品A", "structured 初回不合格→次合格: 戻り値はescalation後の構造化出力");

  assertEqual(usageLogMock.calls.length, 2, "structured 初回不合格→次合格: recordAIUsageは2回呼ばれる");
  const [first, second] = usageLogMock.calls;
  assertEqual(first.result?.qualityGatePassed, false, "structured 1件目: recordAIUsageに渡るqualityGatePassedは実際の判定どおりfalse");
  assertTrue((first.result?.qualityGateViolations ?? []).some((v: string) => v.startsWith("SCHEMA_VIOLATION")), "structured 1件目: qualityGateViolationsに実際の不合格理由(SCHEMA_VIOLATION)が残る");
  assertEqual(second.result?.qualityGatePassed, true, "structured 2件目: recordAIUsageに渡るqualityGatePassedはtrue");
}

async function testTextInitialFailThenEscalationThrows() {
  usageLogMock.__reset();
  providerMock.__configure([{ output: "" }, { error: "PREMIUM呼出が失敗しました(fake)" }], ["economy-model", "premium-model"]);

  let thrown: unknown = null;
  try {
    await gateway.generateText({
      task: "CUSTOMER_REPLY_DRAFT",
      systemPrompt: "s",
      userPrompt: "u",
      tier: "ECONOMY",
      promptVersion: "test-v1",
    });
  } catch (err) {
    thrown = err;
  }

  assertTrue(thrown instanceof Error, "text 初回不合格→次例外: 元の例外がそのままcallerへ伝播する");
  assertEqual(usageLogMock.calls.length, 2, "text 初回不合格→次例外: recordAIUsageは2回呼ばれる(初回成功分+escalation失敗分)");
  const [first, second] = usageLogMock.calls;
  assertEqual(first.success, true, "text 初回不合格→次例外: 1件目(初回)はsuccess=true(欠損しない、旧実装のバグの再現防止)");
  assertEqual(first.result?.qualityGatePassed, false, "text 初回不合格→次例外: 1件目のqualityGatePassedは実際の判定どおりfalse");
  assertEqual(second.success, false, "text 初回不合格→次例外: 2件目(escalation)はsuccess=false");
  assertEqual(second.result, null, "text 初回不合格→次例外: 2件目はresult=null(生成そのものが例外)");
  assertTrue(typeof second.errorMessage === "string" && second.errorMessage.includes("PREMIUM呼出が失敗しました"), "text 初回不合格→次例外: errorMessageに失敗理由が残る");
}

async function testUsageLogFailureDoesNotAffectGenerationOrCount() {
  // recordAIUsage(mock)自体が例外を投げても、生成回数・戻り値は変わらない
  // ことを実gateway.ts+router.tsの経路で確認する(router.tsのnotifyAttempt
  // が握りつぶす設計 — 単体テストではrouter.ts側で既に確認済みだが、
  // gateway.tsが実際にその契約どおりonAttempt/onFailureを配線しているかを
  // ここで結合確認する)。
  usageLogMock.__reset();
  providerMock.__configure([{ output: "" }, { output: "escalation後の返信文です。" }], ["economy-model", "premium-model"]);
  let hookCalls = 0;
  // usageLogMock.recordAIUsageの内部実装を一時的に例外を投げるものへ
  // 差し替える(ESMのnamed exportは呼び出し元から見て読み取り専用の
  // live bindingで再定義できないため、mock自身が用意した__setImpl経由で
  // 委譲先だけを差し替える)。
  usageLogMock.__setImpl(async () => {
    hookCalls++;
    throw new Error("記録先DB書き込み失敗(fake)");
  });
  try {
    const result = await gateway.generateText({
      task: "CUSTOMER_REPLY_DRAFT",
      systemPrompt: "s",
      userPrompt: "u",
      tier: "ECONOMY",
      promptVersion: "test-v1",
    });
    assertEqual(result.output, "escalation後の返信文です。", "ログ書込み例外: recordAIUsageが失敗しても生成結果は正しく返る");
    assertEqual(providerMock.__callCount(), 2, "ログ書込み例外: provider呼出回数は変わらない(初回+escalationの2回のまま)");
    assertEqual(hookCalls, 2, "ログ書込み例外: recordAIUsage(失敗する差し替え後)は初回・escalation両方で呼ばれている");
  } finally {
    usageLogMock.__resetImpl();
  }
}

async function testTextInitialSuccessSingleRecord() {
  usageLogMock.__reset();
  providerMock.__configure([{ output: "最初から良い返信文です。" }], ["economy-model"]);

  const result = await gateway.generateText({
    task: "CUSTOMER_REPLY_DRAFT",
    systemPrompt: "s",
    userPrompt: "u",
    tier: "STANDARD",
    promptVersion: "test-v1",
  });

  assertTrue(!result.fallbackOccurred, "text 初回成功1件: escalationしない");
  assertEqual(usageLogMock.calls.length, 1, "text 初回成功1件: recordAIUsageは1回だけ(欠損/重複なし)");
  assertEqual(usageLogMock.calls[0]?.result?.qualityGatePassed, true, "text 初回成功1件: qualityGatePassedはtrue");
  assertEqual(usageLogMock.calls[0]?.result?.fallbackOccurred, false, "text 初回成功1件: fallbackOccurredはfalse");
}

async function main() {
  await testTextInitialFailThenEscalationPass();
  await testStructuredInitialFailThenEscalationPass();
  await testTextInitialFailThenEscalationThrows();
  await testUsageLogFailureDoesNotAffectGenerationOrCount();
  await testTextInitialSuccessSingleRecord();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
