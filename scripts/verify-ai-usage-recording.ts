/**
 * task_5589フォローアップ: 品質ゲート不合格→escalation時に、初回
 * (ECONOMY/STANDARD)の既知usageがAIUsageLog記録から失われる/
 * escalation自体が例外の場合は初回成功分の記録すら残らない、という
 * 費用記録漏れの回帰テスト。
 *
 * task_a5f83718 レビュー補正: 当初のこのテストはonAttempt呼び出しの
 * 回数・escalatedフラグ・費用計算だけを検証しており、「記録される
 * qualityGatePassed/qualityGateViolationsが実際の品質判定と一致するか」
 * は確認していなかった。router.ts側の実装は
 * provider呼出→notifyAttempt(判定前の生の結果)→checkTextQuality
 * という順序になっており、providerは品質ゲートを知らず
 * qualityGatePassed:true固定で返す(anthropicProvider.ts等参照)ため、
 * 実際は不合格の試行でも記録にはqualityGatePassed:trueが残っていた
 * (=実際の品質不合格がログから読み取れない)。この回帰を検出できる
 * よう、fake providerもqualityGatePassed:true固定(本物のprovider実装
 * と同じ振る舞い)で返し、テスト側は記録された値(=router.tsが判定を
 * 適用した後の値である想定)を検証する。
 *
 * lib/ai/gateway/router.tsの実コード(fake providerで実行 — 実
 * Anthropic/Bedrock/Nova呼び出しはしない)を対象に、onAttempt/
 * onFailureフック経由で「provider呼出が完了する度」に正しく通知される
 * ことを検証する。lib/ai/gateway/gateway.ts自体(実provider/
 * recordAIUsageの境界)を通した結合確認は
 * scripts/verify-ai-gateway-recording.ts で行う(このファイルは
 * router.tsの純粋なロジックだけを対象にした高速な単体テスト)。
 *
 * Run with: npm run verify:ai-usage-recording (依存ゼロ・node単体で動く)
 */
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

// registerHooksはNode 22.15/23で追加されたnode:moduleのAPI(実行環境の
// Node 24には実在するが、本プロジェクトの@types/node(^20.14.0)には型が
// 無い)。qa-worktree-tooling-limitsと同じ理由でテスト専用に最小限だけ
// アンビエント宣言する。
declare module "node:module" {
  export function registerHooks(hooks: {
    resolve?: (specifier: string, context: { parentURL?: string }, nextResolve: (specifier: string, context: unknown) => unknown) => unknown;
  }): void;
}

// このファイルが依存するrouter.ts/qualityGate.ts/types.tsはいずれも
// "server-only"や外部SDKに依存しない純粋モジュールだが、"@/"エイリアス
// (tsconfigのpaths)はNodeネイティブでは解決できないため、ここだけ肩代わりする。
const projectRoot = pathToFileURL(process.cwd() + "/").href;
registerHooks({
  resolve(specifier, _context, nextResolve) {
    const target = specifier.startsWith("@/") ? projectRoot + specifier.slice(2) : specifier;
    try {
      return nextResolve(target, _context);
    } catch {
      return nextResolve(target + ".ts", _context);
    }
  },
});

const { routeGenerateText, routeGenerateStructured } = await import("@/lib/ai/gateway/router");
type AIGenerateResult<T> = { output: T } & Record<string, unknown>;
type AITokenUsage = { inputTokens: number; outputTokens: number };
type AIToolSchema = { name: string; description: string; input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] } };

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

type Step = { output: string } | { error: string };

/** 呼出順にstepsを消費するfake provider。実ネットワーク呼び出しは一切しない。 */
function makeFakeProvider(steps: Step[], modelIdByCallIndex: string[] = []) {
  let call = 0;
  const provider = {
    providerId: "fake",
    callCount: 0,
    async generateText(): Promise<AIGenerateResult<string>> {
      const step = steps[Math.min(call, steps.length - 1)];
      const modelId = modelIdByCallIndex[call] ?? "fake-model";
      provider.callCount++;
      call++;
      if ("error" in step) throw new Error(step.error);
      return {
        output: step.output,
        usage: { inputTokens: 10 * call, outputTokens: 5 * call },
        latencyMs: 1,
        providerId: "fake",
        modelId,
        qualityTier: "STANDARD",
        fallbackOccurred: false,
        // 本物のprovider実装(anthropicProvider.ts等)と同じく、providerは
        // 品質ゲートを知らずtrue固定で返す — router.tsが判定後に上書き
        // することを前提にしている(これがこのファイルで検証したい契約)。
        qualityGatePassed: true,
        qualityGateViolations: [],
      };
    },
    async generateStructured<T>(): Promise<AIGenerateResult<T>> {
      const step = steps[Math.min(call, steps.length - 1)];
      const modelId = modelIdByCallIndex[call] ?? "fake-model";
      provider.callCount++;
      call++;
      if ("error" in step) throw new Error(step.error);
      return {
        output: JSON.parse(step.output) as T,
        usage: { inputTokens: 10 * call, outputTokens: 5 * call },
        latencyMs: 1,
        providerId: "fake",
        modelId,
        qualityTier: "STANDARD",
        fallbackOccurred: false,
        qualityGatePassed: true,
        qualityGateViolations: [],
      };
    },
    async healthCheck() {
      return { ok: true, message: "fake" };
    },
    estimateCost(modelId: string, usage: AITokenUsage): number | null {
      // §3.2契約どおり: モデル別の単価。ここでは2モデル分だけ用意し、
      // 「異なるモデル単価を誤って合算しない」ことを検証できるようにする。
      const perMillion: Record<string, { in: number; out: number }> = {
        "economy-model": { in: 1, out: 2 },
        "premium-model": { in: 10, out: 20 },
      };
      const price = perMillion[modelId];
      if (!price) return null;
      return (usage.inputTokens / 1_000_000) * price.in + (usage.outputTokens / 1_000_000) * price.out;
    },
  };
  return provider;
}

type AttemptRecord = {
  modelId: string;
  usage: AITokenUsage;
  estimatedCostUsd: number | null;
  escalated: boolean;
  recordedFallbackOccurred: boolean;
  qualityGatePassed: boolean;
  qualityGateViolations: string[];
};
type FailureRecord = { message: string; escalated: boolean };

function makeRecorder(provider: ReturnType<typeof makeFakeProvider>) {
  const successes: AttemptRecord[] = [];
  const failures_: FailureRecord[] = [];
  return {
    successes,
    failures: failures_,
    // gateway.tsのonAttempt/onFailureと同じ形を再現する — providerの
    // result.fallbackOccurredは常にfalse固定なので、recordAIUsageへ渡す
    // 直前でescalatedによる上書きをしないと1件目・2件目ともfalseのまま
    // 記録されてしまう(escalation呼出のログ行が誤ってfallbackOccurred:
    // falseになる回帰)。qualityGatePassed/qualityGateViolationsは
    // router.ts側で既に判定済みの値をそのまま受け取る想定 —— これが
    // notifyAttemptの実行順序(判定前か後か)の回帰を検出する。
    onAttempt: async ({ result, escalated }: { result: AIGenerateResult<unknown> & { qualityGatePassed: boolean; qualityGateViolations: string[] }; escalated: boolean }) => {
      const recordedResult = { ...result, fallbackOccurred: escalated };
      successes.push({
        modelId: result.modelId as string,
        usage: result.usage as AITokenUsage,
        estimatedCostUsd: provider.estimateCost(result.modelId as string, result.usage as AITokenUsage),
        escalated,
        recordedFallbackOccurred: recordedResult.fallbackOccurred,
        qualityGatePassed: recordedResult.qualityGatePassed,
        qualityGateViolations: recordedResult.qualityGateViolations,
      });
    },
    onFailure: async ({ error, escalated }: { error: unknown; escalated: boolean }) => {
      failures_.push({ message: error instanceof Error ? error.message : String(error), escalated });
    },
  };
}

async function testInitialSuccessNoEscalation() {
  const provider = makeFakeProvider([{ output: "最初から良い返信文です。" }], ["economy-model"]);
  const rec = makeRecorder(provider);
  const result = await routeGenerateText(provider as never, {
    task: "CUSTOMER_REPLY_DRAFT",
    systemPrompt: "s",
    userPrompt: "u",
    policy: { initialTier: "STANDARD", promptVersion: "test-v1" },
    onAttempt: rec.onAttempt as never,
    onFailure: rec.onFailure,
  });
  assertTrue(!result.fallbackOccurred, "初回合格: escalationしない");
  assertEqual(provider.callCount, 1, "初回合格: provider呼出は1回だけ");
  assertEqual(rec.successes.length, 1, "初回合格: 成功記録は1件だけ(既存の欠損/重複なし)");
  assertEqual(rec.failures.length, 0, "初回合格: 失敗記録は無い");
  assertEqual(rec.successes[0]?.escalated, false, "初回合格: 記録はescalated=falseの初回分");
  assertTrue(rec.successes[0]?.qualityGatePassed === true, "初回合格: 記録されたqualityGatePassedも合格(true)");
  assertEqual(rec.successes[0]?.qualityGateViolations, [], "初回合格: 記録されたqualityGateViolationsは空");
}

async function testEscalationSuccessRecordsBoth() {
  // 初回(ECONOMY, 空文字で品質ゲート不合格)→PREMIUMへescalationし成功。
  const provider = makeFakeProvider([{ output: "" }, { output: "ちゃんとした返信文です。" }], ["economy-model", "premium-model"]);
  const rec = makeRecorder(provider);
  const result = await routeGenerateText(provider as never, {
    task: "CUSTOMER_REPLY_DRAFT",
    systemPrompt: "s",
    userPrompt: "u",
    policy: { initialTier: "ECONOMY", promptVersion: "test-v1" },
    onAttempt: rec.onAttempt as never,
    onFailure: rec.onFailure,
  });
  assertTrue(result.fallbackOccurred, "escalation成功: fallbackOccurred=true");
  assertEqual(result.output, "ちゃんとした返信文です。", "escalation成功: 本文は最終(escalation後)の結果のまま");
  assertEqual(provider.callCount, 2, "escalation成功: provider呼出は2回(無条件二重生成にはならない、品質ゲート不合格分だけ)");
  assertEqual(rec.successes.length, 2, "escalation成功: 初回+escalationの2件とも記録される(既知usageの欠損なし)");
  assertEqual(rec.successes[0]?.escalated, false, "escalation成功: 1件目は初回(ECONOMY)分");
  assertEqual(rec.successes[0]?.modelId, "economy-model", "escalation成功: 1件目のmodelIdはECONOMY側のまま");
  assertEqual(rec.successes[1]?.escalated, true, "escalation成功: 2件目はescalation(PREMIUM)分");
  assertEqual(rec.successes[1]?.modelId, "premium-model", "escalation成功: 2件目のmodelIdはPREMIUM側");

  // レビュー指摘の回帰対応(本題): fake providerはanthropicProvider.ts等と
  // 同じくqualityGatePassed:true固定で返す。もしnotifyAttemptが
  // checkTextQualityより前に実行されていたら、1件目(空文字=本来不合格)
  // の記録もtrueのままになってしまう。router.tsの修正後は、1件目は
  // 実際の判定どおりfalse(EMPTY_OUTPUT)、2件目はtrueで記録される。
  assertTrue(rec.successes[0]?.qualityGatePassed === false, "escalation成功: 1件目(空文字)の記録済みqualityGatePassedは実際の判定どおりfalse(providerの固定trueをそのまま記録しない)");
  assertTrue(
    (rec.successes[0]?.qualityGateViolations ?? []).some((v) => v.startsWith("EMPTY_OUTPUT")),
    "escalation成功: 1件目の記録済みqualityGateViolationsに実際の不合格理由(EMPTY_OUTPUT)が残る",
  );
  assertTrue(rec.successes[1]?.qualityGatePassed === true, "escalation成功: 2件目(escalation後の正常な本文)の記録済みqualityGatePassedはtrue");
  assertEqual(rec.successes[1]?.qualityGateViolations, [], "escalation成功: 2件目の記録済みqualityGateViolationsは空");

  // レビュー指摘の回帰対応: providerが返すfallbackOccurredは常にfalse
  // 固定(fake providerもそう返す)なので、recordAIUsageへ渡す直前で
  // escalatedによる上書きをしないと1件目・2件目ともfalseのまま記録
  // されてしまう(escalation呼出のログ行が誤ってfallbackOccurred:false
  // になる回帰)。1件目(初回)はfalse、2件目(escalation)はtrueで
  // 記録される想定であることを検証する。
  assertEqual(rec.successes[0]?.recordedFallbackOccurred, false, "escalation成功: 1件目の記録用fallbackOccurredはfalse(初回分)");
  assertEqual(rec.successes[1]?.recordedFallbackOccurred, true, "escalation成功: 2件目の記録用fallbackOccurredはtrue(escalation分、providerの固定falseを流用しない)");
  // 異なるモデル単価を誤って合算しない: 各記録のestimatedCostUsdはそのモデル自身の単価から算出されている。
  assertTrue(rec.successes[0]!.estimatedCostUsd! < rec.successes[1]!.estimatedCostUsd!, "escalation成功: PREMIUM側の単価はECONOMY側より高く、それぞれ個別に計算されている(合算していない)");
  const expectedEconomyCost = (rec.successes[0]!.usage.inputTokens / 1_000_000) * 1 + (rec.successes[0]!.usage.outputTokens / 1_000_000) * 2;
  assertEqual(rec.successes[0]!.estimatedCostUsd, expectedEconomyCost, "escalation成功: ECONOMY側のestimatedCostUsdはECONOMY単価だけで計算されている");
}

async function testInitialSuccessThenEscalationThrowsKeepsFirst() {
  // 初回(ECONOMY, 空文字で品質ゲート不合格)は成功するがescalation呼出自体が例外。
  const provider = makeFakeProvider([{ output: "" }, { error: "PREMIUM呼出が失敗しました(fake)" }], ["economy-model", "premium-model"]);
  const rec = makeRecorder(provider);
  let thrown: unknown = null;
  try {
    await routeGenerateText(provider as never, {
      task: "CUSTOMER_REPLY_DRAFT",
      systemPrompt: "s",
      userPrompt: "u",
      policy: { initialTier: "ECONOMY", promptVersion: "test-v1" },
      onAttempt: rec.onAttempt as never,
      onFailure: rec.onFailure,
    });
  } catch (err) {
    thrown = err;
  }
  assertTrue(thrown instanceof Error, "初回成功+escalation例外: 例外はそのままcallerへ伝播する");
  assertEqual(rec.successes.length, 1, "初回成功+escalation例外: 初回成功分の記録は失われない(旧実装のバグの再現防止)");
  assertEqual(rec.successes[0]?.escalated, false, "初回成功+escalation例外: 残る成功記録はescalated=falseの初回分");
  assertTrue(rec.successes[0]?.qualityGatePassed === false, "初回成功+escalation例外: 残る成功記録のqualityGatePassedも実際の判定どおりfalse");
  assertEqual(rec.failures.length, 1, "初回成功+escalation例外: escalation失敗分の記録が1件ある");
  assertEqual(rec.failures[0]?.escalated, true, "初回成功+escalation例外: 失敗記録はescalated=true(どちらの呼出が失敗したか判別できる)");
}

async function testInitialFailureNoSuccessRecord() {
  const provider = makeFakeProvider([{ error: "初回呼出が失敗しました(fake)" }], ["economy-model"]);
  const rec = makeRecorder(provider);
  let thrown: unknown = null;
  try {
    await routeGenerateText(provider as never, {
      task: "CUSTOMER_REPLY_DRAFT",
      systemPrompt: "s",
      userPrompt: "u",
      policy: { initialTier: "ECONOMY", promptVersion: "test-v1" },
      onAttempt: rec.onAttempt as never,
      onFailure: rec.onFailure,
    });
  } catch (err) {
    thrown = err;
  }
  assertTrue(thrown instanceof Error, "初回例外: 例外はそのままcallerへ伝播する");
  assertEqual(provider.callCount, 1, "初回例外: 追加のescalation呼出は発生しない");
  assertEqual(rec.successes.length, 0, "初回例外: 成功記録は無い(fake successにしない)");
  assertEqual(rec.failures.length, 1, "初回例外: 失敗記録が1件だけある");
  assertEqual(rec.failures[0]?.escalated, false, "初回例外: 失敗記録はescalated=false(初回分)");
}

async function testRecordingFailureDoesNotDuplicateGeneration() {
  // ログ保存自体が例外を投げても(recordAIUsage失敗を模す)、追加の
  // provider呼出は発生しない/最終結果は正しく返る。
  const provider = makeFakeProvider([{ output: "" }, { output: "escalation後の返信文です。" }], ["economy-model", "premium-model"]);
  const observedEscalatedFlags: boolean[] = [];
  const result = await routeGenerateText(provider as never, {
    task: "CUSTOMER_REPLY_DRAFT",
    systemPrompt: "s",
    userPrompt: "u",
    policy: { initialTier: "ECONOMY", promptVersion: "test-v1" },
    onAttempt: async ({ escalated }: { escalated: boolean }) => {
      observedEscalatedFlags.push(escalated);
      throw new Error("記録先DB書き込み失敗(fake)");
    },
  });
  assertEqual(provider.callCount, 2, "ログ保存例外: 記録失敗があってもprovider呼出回数は変わらない(初回+escalationの2回のまま、追加生成なし)");
  assertEqual(observedEscalatedFlags, [false, true], "ログ保存例外: onAttempt自体は初回・escalation両方で正しく呼ばれている");
  assertEqual(result.output, "escalation後の返信文です。", "ログ保存例外: 記録が失敗しても生成結果は正しく返る(ログは補助情報)");
}

async function testStructuredPathRecordsPerAttempt() {
  const toolSchema: AIToolSchema = { name: "t", description: "d", input_schema: { type: "object", properties: {} } };
  const provider = makeFakeProvider([{ output: JSON.stringify({ title: "" }) }, { output: JSON.stringify({ title: "商品A" }) }], ["economy-model", "premium-model"]);
  const rec = makeRecorder(provider);
  const result = await routeGenerateStructured<{ title: string }>(provider as never, {
    task: "LISTING_TITLE_GENERATION",
    systemPrompt: "s",
    userPrompt: "u",
    toolSchema,
    policy: { initialTier: "ECONOMY", promptVersion: "test-v1" },
    requiredNonEmptyFields: ["title"],
    onAttempt: rec.onAttempt as never,
    onFailure: rec.onFailure,
  });
  assertTrue(result.fallbackOccurred, "structured経路: schema violationでescalationが発生する");
  assertEqual(result.output.title, "商品A", "structured経路: 出力は最終(escalation後)の構造化結果のまま");
  assertEqual(rec.successes.length, 2, "structured経路: 初回+escalationの2件とも記録される");
  assertEqual(rec.successes[0]?.modelId, "economy-model", "structured経路: 1件目はECONOMY側のmodelId");
  assertEqual(rec.successes[1]?.modelId, "premium-model", "structured経路: 2件目はPREMIUM側のmodelId");
  assertTrue(rec.successes[0]?.qualityGatePassed === false, "structured経路: 1件目(title空)の記録済みqualityGatePassedは実際の判定どおりfalse");
  assertTrue(
    (rec.successes[0]?.qualityGateViolations ?? []).some((v) => v.startsWith("SCHEMA_VIOLATION")),
    "structured経路: 1件目の記録済みqualityGateViolationsに実際の不合格理由(SCHEMA_VIOLATION)が残る",
  );
  assertTrue(rec.successes[1]?.qualityGatePassed === true, "structured経路: 2件目(title埋まっている)の記録済みqualityGatePassedはtrue");
}

async function testPremiumInitialNoEscalationSingleRecord() {
  // 既にPREMIUM指定なら、品質ゲート不合格でもescalationしようがない(そのまま返す) — 記録は1件だけ。
  const provider = makeFakeProvider([{ output: "" }], ["premium-model"]);
  const rec = makeRecorder(provider);
  const result = await routeGenerateText(provider as never, {
    task: "CUSTOMER_REPLY_DRAFT",
    systemPrompt: "s",
    userPrompt: "u",
    policy: { initialTier: "PREMIUM", promptVersion: "test-v1" },
    onAttempt: rec.onAttempt as never,
    onFailure: rec.onFailure,
  });
  assertTrue(!result.fallbackOccurred, "PREMIUM初回: これ以上escalationしない");
  assertTrue(!result.qualityGatePassed, "PREMIUM初回: 品質ゲート不合格のままでもfake successにしない");
  assertEqual(provider.callCount, 1, "PREMIUM初回: provider呼出は1回だけ");
  assertEqual(rec.successes.length, 1, "PREMIUM初回: 記録は1件だけ(欠損/重複なし)");
  assertTrue(rec.successes[0]?.qualityGatePassed === false, "PREMIUM初回: 記録済みqualityGatePassedも不合格のままfalse");
}

async function main() {
  await testInitialSuccessNoEscalation();
  await testEscalationSuccessRecordsBoth();
  await testInitialSuccessThenEscalationThrowsKeepsFirst();
  await testInitialFailureNoSuccessRecord();
  await testRecordingFailureDoesNotDuplicateGeneration();
  await testStructuredPathRecordsPerAttempt();
  await testPremiumInitialNoEscalationSingleRecord();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
