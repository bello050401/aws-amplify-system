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
import { getModelForTier, getModelById, MODEL_REGISTRY, getBedrockModelForTier, getBedrockModelById, BEDROCK_MODEL_REGISTRY } from "@/lib/ai/gateway/modelRegistry";
import { resolveProviderId } from "@/lib/ai/gateway/gateway";
import { describeBedrockError } from "@/lib/ai/gateway/bedrockProvider";
import type { AIGatewayProvider, AIGenerateResult, AIToolSchema } from "@/lib/ai/gateway/types";
import { buildListingUserPrompt, buildReplySystemPrompt, buildReplyUserPrompt, type ListingCopyGenerationInput, type ReplyDraftInput } from "@/lib/ai/ecCopy";

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

/**
 * 不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §6.3/§6.5: AI下書き
 * 生成・AI返信案生成に「自社内での連絡事項」(adminMemo)が絶対に
 * 混入しないことの回帰テスト。`ListingCopyGenerationInput`/
 * `ReplyDraftInput`という型自体にadminMemoフィールドが存在しないこと
 * (lib/ai/ecCopy.tsのコメント参照)がコンパイル時の一次的な保証だが、
 * ここでは実際に組み立てられるプロンプト文字列そのものを検証する
 * ——将来誰かが誤って`{...inventory}`のようにInventory全体を
 * spreadしてしまっても検知できるよう、型のexcess property checkを
 * `as`で意図的にすり抜けさせた「事故を模したinput」を実際に渡す。
 */
function testAiPromptsNeverLeakAdminMemo() {
  const SECRET_SENTINEL = "【厳秘・社内連絡：仕入先クレーム対応中】";

  // 型には存在しないadminMemoを無理やり紛れ込ませた入力(実際の事故を
  // 模す) — TypeScriptの構造的型付けはexcess propertyを許すため、
  // `as`無しでも代入できてしまう変数経由で渡すことで、この型安全性の
  // 抜け穴を意図的に再現している。
  const listingInputWithLeak = {
    name: "北欧デザインダイニングチェア",
    note: "座面に軽微な傷あり",
    adminMemo: SECRET_SENTINEL,
  } as ListingCopyGenerationInput & { adminMemo: string };
  const listingPrompt = buildListingUserPrompt(listingInputWithLeak);
  assertTrue(!listingPrompt.includes(SECRET_SENTINEL), "buildListingUserPrompt: adminMemoに相当する値がinputに混入していても、組み立てたプロンプト文字列には一切現れない");
  assertTrue(listingPrompt.includes("北欧デザインダイニングチェア"), "buildListingUserPrompt: 正規のフィールド(商品名)は正しく含まれる(除外ロジックが過剰でないことの確認)");

  const replyInputWithLeak = {
    channel: "MERCARI_SHOPS",
    inquiryBody: "この商品はまだありますか？",
    productName: "北欧デザインダイニングチェア",
    adminMemo: SECRET_SENTINEL,
  } as ReplyDraftInput & { adminMemo: string };
  const replyPrompt = buildReplyUserPrompt(replyInputWithLeak);
  assertTrue(!replyPrompt.includes(SECRET_SENTINEL), "buildReplyUserPrompt: adminMemoに相当する値がinputに混入していても、組み立てたプロンプト文字列には一切現れない");
  assertTrue(replyPrompt.includes("北欧デザインダイニングチェア"), "buildReplyUserPrompt: 正規のフィールド(商品名)は正しく含まれる");

  const replySystemPrompt = buildReplySystemPrompt();
  assertTrue(replySystemPrompt.includes("内部情報"), "buildReplySystemPrompt: 「顧客へ内部情報を一切出さない」という明示指示がsystem promptに含まれる(§50 BELLO返信ルール)");
}

// ── 夜間指示書§6: AI ProviderのAWS(Bedrock)既定化 ────────────────────
// 以前は無条件にAnthropic直APIを選んでいたため、ANTHROPIC_API_KEYが
// 無い環境では商品説明の自動生成が必ず
// 「ANTHROPIC_API_KEYが設定されていません。」で失敗していた。
// BELLOはAWS上でIAMロールを持って動くので、キーが無ければBedrockを既定に
// する(追加のキー発行も保管も不要)。
function testProviderResolution() {
  assertEqual(resolveProviderId({ ANTHROPIC_API_KEY: "sk-xxx" }), "anthropic", "resolveProviderId: APIキーがあればAnthropic直APIを使う(既存挙動を維持)");
  assertEqual(resolveProviderId({}), "bedrock", "resolveProviderId: APIキーが無ければBedrockへ倒す(キー未設定で機能停止しない)");
  assertEqual(resolveProviderId({ AI_GATEWAY_PROVIDER: "bedrock", ANTHROPIC_API_KEY: "sk-xxx" }), "bedrock", "resolveProviderId: 明示指定はAPIキーより優先(キーがある環境でもBedrockを試せる)");
  assertEqual(resolveProviderId({ AI_GATEWAY_PROVIDER: "anthropic" }), "anthropic", "resolveProviderId: 明示指定はフォールバックより優先(キーが無くてもAnthropicを強制できる)");
  assertEqual(resolveProviderId({ AI_GATEWAY_PROVIDER: "  BEDROCK  " }), "bedrock", "resolveProviderId: 前後の空白と大文字小文字を許容する");
  assertEqual(resolveProviderId({ AI_GATEWAY_PROVIDER: "unknown-provider" }), "bedrock", "resolveProviderId: 未知の値はキーの有無による既定判定へ落ちる(未知の名前で起動不能にしない)");
}

function testBedrockModelRegistry() {
  for (const tier of ["ECONOMY", "STANDARD", "PREMIUM"] as const) {
    const m = getBedrockModelForTier(tier);
    assertEqual(m.providerId, "bedrock", `getBedrockModelForTier(${tier}): providerIdはbedrock`);
    assertTrue(m.modelId.includes("anthropic."), `getBedrockModelForTier(${tier}): BedrockのモデルIDはanthropic.接頭辞を持つ(Anthropic直APIの綴りとは異なる)`);
    assertTrue(m.maxOutputTokens > 0, `getBedrockModelForTier(${tier}): maxOutputTokensが正`);
    assertTrue(getBedrockModelById(m.modelId) !== undefined, `getBedrockModelById: ${tier}のモデルIDで引ける`);
  }
  // 実測で存在を確認したモデルだけを登録する(存在しないIDはescalation時に
  // 必ずValidationExceptionで落ちるため)。
  const premium = getBedrockModelForTier("PREMIUM");
  const standard = getBedrockModelForTier("STANDARD");
  assertTrue(
    BEDROCK_MODEL_REGISTRY.every((m) => m.modelId.startsWith("us.anthropic.") || m.modelId.startsWith("anthropic.")),
    "BEDROCK_MODEL_REGISTRY: 全モデルIDがBedrockの綴り(推論プロファイルまたは素のモデルID)",
  );
  assertEqual(premium.modelId, standard.modelId, "BEDROCK_MODEL_REGISTRY: us-west-2で実在を確認できたAnthropicモデルはHaiku 4.5/Sonnet 4のみのため、PREMIUMはSonnet 4で代替する(存在しないOpusのIDを登録しない)");
}

function testBedrockErrorMessages() {
  const verifying = describeBedrockError(
    Object.assign(new Error("Your account is currently being verified. Verification normally takes less than 2 hours."), { name: "AccessDeniedException" }),
  );
  assertTrue(verifying.includes("検証"), "describeBedrockError: アカウント検証待ちを利用者に分かる日本語で説明する");
  assertTrue(!verifying.includes("AccessDenied"), "describeBedrockError: 内部の例外名をそのまま利用者へ出さない");

  const denied = describeBedrockError(Object.assign(new Error("User is not authorized to perform bedrock:InvokeModel"), { name: "AccessDeniedException" }));
  assertTrue(denied.includes("権限"), "describeBedrockError: 権限不足は検証待ちと区別して案内する");

  const throttled = describeBedrockError(Object.assign(new Error("Too many requests"), { name: "ThrottlingException" }));
  assertTrue(throttled.includes("混雑"), "describeBedrockError: スロットリングは再試行を促す文言にする");
}

async function main() {
  testQualityGateText();
  testQualityGateStructured();
  testModelRegistry();
  testProviderResolution();
  testBedrockModelRegistry();
  testBedrockErrorMessages();
  await testRouterEscalation();
  await testBenchmarkHarness();
  testAiPromptsNeverLeakAdminMemo();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
