/**
 * BELLOベンダー非依存・交換可能アーキテクチャ仕様書(2026-08-30) §4/§18:
 * AI Gatewayの純粋ロジック(qualityGate.ts)+ Router(router.ts、
 * fake providerで検証 — 実Anthropic呼び出しはしない)のstandalone
 * verification。
 *
 * §18「Providerを差し替えてもApplication Serviceの契約が変わらない」
 * 「structured output validation failure→上位model escalation」を
 * 実際にテストする。
 *
 * Run with: npm run verify:ai-gateway
 */
import { checkTextQuality, checkStructuredQuality } from "@/lib/ai/gateway/qualityGate";
import { routeGenerateText, routeGenerateStructured } from "@/lib/ai/gateway/router";
import { runBenchmark, BENCHMARK_CASES } from "@/lib/ai/gateway/benchmark";
import { getModelForTier, getModelById, MODEL_REGISTRY } from "@/lib/ai/gateway/modelRegistry";
import type { AIGatewayProvider, AIGenerateResult, AIToolSchema } from "@/lib/ai/gateway/types";

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

function testQualityGateText() {
  assertTrue(checkTextQuality("こんにちは、商品についてご案内します。").pass, "checkTextQuality: 正常なテキストはpass");
  assertTrue(!checkTextQuality("").pass, "checkTextQuality: 空文字はfail(EMPTY_OUTPUT)");
  assertTrue(!checkTextQuality("短", { minLength: 10 }).pass, "checkTextQuality: minLength未満はfail(TOO_SHORT)");
  assertTrue(!checkTextQuality("あ".repeat(100), { maxLength: 50 }).pass, "checkTextQuality: maxLength超過はfail(TOO_LONG)");
  assertTrue(!checkTextQuality("仕入原価は¥1,000です").pass, "checkTextQuality: 内部情報漏洩パターン(仕入原価)を検出してfail");
  assertTrue(!checkTextQuality("送料は3,000円です", { forbiddenPatterns: [/送料.*円/] }).pass, "checkTextQuality: 呼び出し元指定のforbiddenPatternsも効く(§69の送料未確定チェック相当)");
  assertTrue(!checkTextQuality("お問い合わせありがとうございます", { requiredSubstrings: ["商品名X"] }).pass, "checkTextQuality: requiredSubstrings欠落はfail(MISSING_REQUIRED_INFO)");
}

function testQualityGateStructured() {
  assertTrue(checkStructuredQuality({ title: "商品A", description: "説明" }, ["title", "description"]).pass, "checkStructuredQuality: 全フィールド埋まっていればpass");
  assertTrue(!checkStructuredQuality({ title: "", description: "説明" }, ["title", "description"]).pass, "checkStructuredQuality: 空文字フィールドはfail(SCHEMA_VIOLATION)");
  assertTrue(
    !checkStructuredQuality({ title: "商品A" } as { title: string; description?: string }, ["title", "description"]).pass,
    "checkStructuredQuality: フィールド自体が無くてもfail",
  );
}

function testModelRegistry() {
  assertEqual(getModelForTier("ECONOMY").qualityTier, "ECONOMY", "getModelForTier: ECONOMYは正しいtierのモデルを返す");
  assertEqual(getModelForTier("STANDARD").modelId, "claude-sonnet-5", "getModelForTier: STANDARDは既存機能が使っていたclaude-sonnet-5(移行前と同じ出力品質を保つ)");
  assertEqual(getModelForTier("PREMIUM").qualityTier, "PREMIUM", "getModelForTier: PREMIUMは正しいtierのモデルを返す");
  assertTrue(MODEL_REGISTRY.every((m) => m.providerId === "anthropic"), "MODEL_REGISTRY: 現状すべてanthropic(§17.3「現在のProviderを最初のAdapterとして維持」)");
  assertTrue(getModelById("does-not-exist") === undefined, "getModelById: 存在しないIDはundefined");
}

/** 実Anthropic呼び出しをしないfake provider — §18のcontract test。 */
function makeFakeProvider(textOutputs: string[]): AIGatewayProvider {
  let call = 0;
  return {
    providerId: "fake",
    async generateText(): Promise<AIGenerateResult<string>> {
      const output = textOutputs[Math.min(call, textOutputs.length - 1)];
      call++;
      return {
        output,
        usage: { inputTokens: 10, outputTokens: 10 },
        latencyMs: 1,
        providerId: "fake",
        modelId: "fake-model",
        qualityTier: "STANDARD",
        fallbackOccurred: false,
        qualityGatePassed: true,
        qualityGateViolations: [],
      };
    },
    async generateStructured<T>(): Promise<AIGenerateResult<T>> {
      const outputs = [{ title: "" }, { title: "商品A" }] as unknown as T[];
      const output = outputs[Math.min(call, outputs.length - 1)];
      call++;
      return {
        output,
        usage: { inputTokens: 10, outputTokens: 10 },
        latencyMs: 1,
        providerId: "fake",
        modelId: "fake-model",
        qualityTier: "STANDARD",
        fallbackOccurred: false,
        qualityGatePassed: true,
        qualityGateViolations: [],
      };
    },
    async healthCheck() {
      return { ok: true, message: "fake" };
    },
    estimateCost() {
      return 0;
    },
  };
}

async function testRouterEscalation() {
  // ECONOMY初回が品質ゲート不合格(空文字)→PREMIUMへ1回だけescalation。
  const providerFailThenPass = makeFakeProvider(["", "ちゃんとした返信文です。"]);
  const result = await routeGenerateText(providerFailThenPass, {
    task: "CUSTOMER_REPLY_DRAFT",
    systemPrompt: "s",
    userPrompt: "u",
    policy: { initialTier: "ECONOMY", promptVersion: "test-v1" },
  });
  assertTrue(result.fallbackOccurred, "routeGenerateText: 品質ゲート不合格でescalationが発生する(fallbackOccurred=true)");
  assertTrue(result.qualityGatePassed, "routeGenerateText: escalation後の結果で品質ゲートがpassしている");
  assertEqual(result.output, "ちゃんとした返信文です。", "routeGenerateText: escalation後の出力が返る");

  // 初回で既に合格していればescalationしない(無条件二重生成禁止 §5)。
  const providerPassImmediately = makeFakeProvider(["最初から良い返信文です。"]);
  const result2 = await routeGenerateText(providerPassImmediately, {
    task: "CUSTOMER_REPLY_DRAFT",
    systemPrompt: "s",
    userPrompt: "u",
    policy: { initialTier: "STANDARD", promptVersion: "test-v1" },
  });
  assertTrue(!result2.fallbackOccurred, "routeGenerateText: 初回合格ならescalationしない(無条件二重生成禁止)");

  // 構造化出力側も同様。
  const toolSchema: AIToolSchema = { name: "t", description: "d", input_schema: { type: "object", properties: {} } };
  const structuredProvider = makeFakeProvider([]);
  const structuredResult = await routeGenerateStructured<{ title: string }>(structuredProvider, {
    task: "LISTING_TITLE_GENERATION",
    systemPrompt: "s",
    userPrompt: "u",
    toolSchema,
    policy: { initialTier: "ECONOMY", promptVersion: "test-v1" },
    requiredNonEmptyFields: ["title"],
  });
  assertTrue(structuredResult.fallbackOccurred, "routeGenerateStructured: schema violation(空title)でescalationが発生する");
  assertEqual(structuredResult.output.title, "商品A", "routeGenerateStructured: escalation後の構造化出力が返る");

  // 既にPREMIUMを指定していた場合はescalationしようがない(そのまま返す)。
  const alwaysFail = makeFakeProvider(["", ""]);
  const premiumResult = await routeGenerateText(alwaysFail, {
    task: "CUSTOMER_REPLY_DRAFT",
    systemPrompt: "s",
    userPrompt: "u",
    policy: { initialTier: "PREMIUM", promptVersion: "test-v1" },
  });
  assertTrue(!premiumResult.fallbackOccurred, "routeGenerateText: 既にPREMIUM指定ならescalationしない(これ以上上位が無い)");
  assertTrue(!premiumResult.qualityGatePassed, "routeGenerateText: PREMIUMでも品質ゲート不合格ならqualityGatePassed=falseのまま返す(fake successにしない)");
}

/**
 * §5/§6: Benchmark harness自体の堅牢性を検証する — このsandbox環境には
 * ANTHROPIC_API_KEYが無い(実際にmessages.createを呼び401
 * invalid x-api-keyを確認済み)ため、実行結果は全件FAILEDになるはずだが、
 * それでも例外を投げず、正しい構造のBenchmarkReportを返すことを確認する
 * (「実Provider credentialsが無い場合でもrunner/schema/result storageを
 * 完成させる」の実地検証)。
 */
async function testBenchmarkHarness() {
  const report = await runBenchmark(["ECONOMY"]);
  assertEqual(report.results.length, BENCHMARK_CASES.length, "runBenchmark: 全ケース分の結果が返る(例外で中断しない)");
  assertEqual(report.summary.total, BENCHMARK_CASES.length, "runBenchmark: summary.totalが正しい");
  assertTrue(
    report.results.every((r) => r.status === "FAILED" || r.status === "SUCCESS"),
    "runBenchmark: 各結果が正しいstatus値を持つ",
  );
  assertTrue(
    report.results.every((r) => r.status !== "FAILED" || typeof r.errorMessage === "string"),
    "runBenchmark: FAILEDの場合は必ずerrorMessageを持つ(fake successにしない)",
  );
}

async function main() {
  testQualityGateText();
  testQualityGateStructured();
  testModelRegistry();
  await testRouterEscalation();
  await testBenchmarkHarness();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
