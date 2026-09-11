/**
 * generateInquiryReplyDraft(lib/inquiry/pipeline.ts)を、外部境界だけを
 * mockして実際に1本通しで呼び出す検証。
 *
 * これまでの2本
 *   - scripts/verify-inquiry-answer-plan.ts          (純粋関数のみ)
 *   - scripts/verify-negotiation-service-boundary.ts (negotiationServiceの
 *     DB境界のみ)
 * は、どちらもgenerateInquiryReplyDraft**全体**を実行しない。このファイルは
 * 実pipelineを通して、質問単位の回答計画(answerPlan.ts)・値引きの根拠判定
 * (isApprovedDiscountGrounded)・再生成の上限(REPLY_MAX_GENERATION_ATTEMPTS)・
 * 識別子を残さないログ、をpipeline.ts自身のコードで確認する。
 *
 * 【mockするのは外部境界だけ】実AI(@/lib/ai/gateway/gateway)・実DynamoDB
 * (@/lib/inventory/queries, @/lib/shipping/service, @/lib/knowledge/store,
 * ./settings, ./productResolver, ./negotiationService, ./baseProductLookup,
 * ./replyRuleStore)・実Web検索/BASE API(./research/service,
 * ./research/agentCoreProvider)。差し替えの実装は
 * scripts/inquiry-pipeline-mock-hooks.mjs(プロセス内ロードhook。disk上の
 * node_modulesは一切書き換えない)を参照。
 *
 * 判定ロジック(answerPlan.ts / validate.ts / negotiation.ts /
 * productContext.ts / conversationContext.ts 等)はすべて原本のまま実行する。
 *
 * 実ネットワーク・実AI・実クラウド・実顧客データへは一切接続しない。
 *
 * Run with: npm run verify:inquiry-pipeline-boundary
 * (Node 22+推奨。--experimental-strip-types と
 *  scripts/inquiry-pipeline-mock-hooks.mjs だけで実行する。tsx は使わない
 *  ——このファイルはpipeline.tsの外部境界をすべてプロセス内mockへ差し替える
 *  ため、pipeline.tsが間接的に引き込む"server-only"/next.js専用exportsに
 *  一切到達しない。node:testのモジュールモック機能(mock.module)は使わず、
 *  Node標準のモジュールカスタマイズフックだけで完結させている)
 *
 * 【合成品質と実AI未検証の違い】ここで固定するのは「pipeline.tsが
 * AIの出力とnegotiationServiceの戻り値をどう扱うか」という**コード側の
 * 挙動**であって、「実際のAIモデルがどんな文章を書くか」ではない。
 * generateTextの戻り値はすべてこのファイルが用意した架空の文字列であり、
 * 実際のAIモデルの品質・プロンプトの効き目は一切検証していない
 * (それは実AI呼び出しを伴う別の確認が要る。未確認事項として完了報告に残す)。
 */
import { generateInquiryReplyDraft } from "@/lib/inquiry/pipeline";
import { extractProductReferences } from "@/lib/inquiry/references";
import { KNOWN_FURNITURE_BRANDS } from "@/lib/ai/productIntro/factSafety";
import type { InquiryReplyRequest } from "@/lib/inquiry/types";

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

/* ══════════════════════════════════════════════════════════════════
 * mock制御(scripts/inquiry-pipeline-mock-hooks.mjs が参照する)
 * ══════════════════════════════════════════════════════════════════ */

type MockImpl = Record<string, (...args: any[]) => unknown>;
type MockState = { impl: MockImpl; calls: Record<string, unknown[][]> };

declare global {
  // eslint-disable-next-line no-var
  var __inquiryPipelineMock: MockState | undefined;
}

/** 架空の商品(合成テスト用。実データ・実顧客文は使わない)。 */
const BASE_INVENTORY = {
  id: "inv-test-1",
  sku: "B000123",
  name: "(合成テスト用の椅子)",
  salePrice: 100_000,
  plannedSalePrice: null as number | null,
  purchasePrice: 50_000,
  saleStartDate: "2026-08-01",
  width: "50",
  depth: "50",
  height: "80",
  quantity: 1,
  categoryId: "cat-1",
  statusId: "status-1",
  conditionRating: null as string | null,
  damageNotes: "傷、汚れはほとんどございません。",
  note: null as string | null,
  images: [] as unknown[],
};

/**
 * シナリオ共通の既定mock。各シナリオはこの一部だけを上書きする。
 * 呼ばれるはずの無い境界(既定ではresolveNegotiation・generateText)は
 * わざと例外を投げ、シナリオが想定外の境界を叩いていないかを検出する。
 */
function installBaseMock(overrides: Partial<MockImpl> = {}): MockState {
  const impl: MockImpl = {
    getAIReplySettings: async () => ({
      autoDraftEnabled: true,
      // ナレッジ・外部Web調査は境界の数を絞るため既定でOFFにする
      // (このテストの主眼はAnswerPlan・値引き根拠・再生成なので、
      // 実際に呼ばれない境界にまで架空の返り値を用意する必要が無い)。
      webResearchEnabled: false,
      knowledgeEnabled: false,
      autoSendEnabled: false,
    }),
    resolveProductFromInquiry: async (params: { messageText: string }) => ({
      status: "RESOLVED",
      resolved: {
        inventoryId: BASE_INVENTORY.id,
        displayInventoryId: BASE_INVENTORY.sku,
        sku: BASE_INVENTORY.sku,
        name: BASE_INVENTORY.name,
        confidence: 0.97,
        reasons: ["(合成テスト固定: 常に一意に解決したものとして扱う)"],
        source: "INVENTORY",
      },
      candidates: [],
      // URL/型番/ブランド等の抽出だけは実物(references.ts)を使う
      // (ここを再実装しない)。
      references: extractProductReferences(params.messageText, KNOWN_FURNITURE_BRANDS),
      usedFullScan: false,
      baseProducts: [],
      onSaleCategoryResolved: true,
      inventorySyncSuspected: false,
      zaicoLastSyncedAt: null,
    }),
    getInventoryDetail: async () => ({ ...BASE_INVENTORY }),
    listCategories: async () => [{ id: "cat-1", name: "チェア", parentId: null, sortOrder: 0 }],
    listStatuses: async () => [{ id: "status-1", code: "ON_SALE", label: "販売中", sortOrder: 0 }],
    lookupShippingRate: async () => ({ price: 8_000, surcharge: null }),
    listShippingRates: async () => [],
    listSearchableKnowledge: async () => [],
    listActiveReplyRules: async () => [],
    lookupBaseProduct: async () => ({ source: "not-found" }),
    lookupBaseProducts: async () => [],
    getAgentCoreGatewayUrl: () => null,
    getWebResearchAvailability: () => ({ available: false, reason: "test: mocked unavailable" }),
    createDirectUrlProvider: () => ({
      id: "direct-url",
      fetchDocuments: async () => ({ status: "NOT_CONFIGURED", reason: "mocked" }),
    }),
    createAgentCoreSearchProvider: () => ({
      id: "agentcore-web-search",
      fetchDocuments: async () => ({ status: "NOT_CONFIGURED", reason: "mocked" }),
    }),
    researchMissingFacts: async () => ({
      attempted: false,
      facts: [],
      documentTexts: [],
      unavailableReason: null,
      searchCallCount: 0,
    }),
    resolveNegotiation: async () => {
      throw new Error("このシナリオではresolveNegotiationは呼ばれない想定です(値引き交渉を含まない問い合わせ)。");
    },
    evaluateOfficialLinePaymentCondition: () => ({ applicable: false, reason: "mocked", sourceDocumentTitle: null }),
    generateText: async () => {
      throw new Error("このシナリオ用のgenerateText実装が設定されていません。");
    },
    ...overrides,
  };
  const state: MockState = { impl, calls: {} };
  globalThis.__inquiryPipelineMock = state;
  return state;
}

function callCount(state: MockState, name: string): number {
  return state.calls[name]?.length ?? 0;
}

function baseRequest(overrides: Partial<InquiryReplyRequest> = {}): InquiryReplyRequest {
  return {
    channel: "LINE",
    conversationId: "conv-test-1",
    messageId: "msg-test-1",
    messageText: "",
    history: [],
    // テスト文面には商品URL/SKU/型番が無い(自然な短文にするため)。
    // conversationInventoryIdを指定し、「会話に元から紐づく商品」
    // (identificationBasis: OPERATOR_OR_CONVERSATION)として扱わせる
    // ——これが無いと、商品名の断片が無いこと(NAME_ONLY未満)を理由に
    // URL提示を求める早期returnへ流れ、generateTextへ到達しない
    // (lib/inquiry/productIdentification.ts のコメント参照)。
    conversationInventoryId: "inv-test-1",
    ...overrides,
  };
}

/* ══════════════════════════════════════════════════════════════════
 * ケース1: 正常1回(単一質問、1回で生成が通る)
 * ══════════════════════════════════════════════════════════════════ */
async function testNormalSingleGeneration() {
  const state = installBaseMock({
    generateText: async () => ({
      output: "サイズは幅50cm・奥行50cm・高さ80cmです。",
      providerId: "anthropic",
      modelId: "test-model-normal",
    }),
  });

  const result = await generateInquiryReplyDraft(
    baseRequest({ messageText: "こちらの椅子のサイズを教えてください。" }),
  );

  assertEqual(callCount(state, "generateText"), 1, "正常1回: generateTextは1回しか呼ばれない");
  assertTrue(result.draftText != null, "正常1回: draftTextが生成される");
  assertEqual(result.modelProvider, "anthropic", "正常1回: modelProviderが呼び出し結果から入る");
  assertEqual(result.modelName, "test-model-normal", "正常1回: modelNameが呼び出し結果から入る");
  assertEqual(result.failureReason, null, "正常1回: failureReasonは無い");
  assertTrue(
    result.evidence.answerPlan?.coverage.every((c) => c.coverage !== "MISSING") ?? false,
    "正常1回: 唯一の質問(サイズ)に答えているのでMISSINGは無い",
  );
}

/* ══════════════════════════════════════════════════════════════════
 * ケース2: 複合質問の一部回答漏れ → 再生成は増やさず、確認事項として積む
 * ══════════════════════════════════════════════════════════════════ */
async function testMissingAnswerDoesNotTriggerRegeneration() {
  const state = installBaseMock({
    // 送料も答えられる状態にする(配送先が本文にある + lookupShippingRateが
    // 料金を返す)。AIはサイズにしか触れず、送料への回答が丸ごと抜ける。
    generateText: async () => ({
      output: "サイズは幅50cm・奥行50cm・高さ80cmです。",
      providerId: "anthropic",
      modelId: "test-model-missing",
    }),
  });

  const unresolvedBefore = 0;
  const result = await generateInquiryReplyDraft(
    baseRequest({ messageText: "サイズを教えてください。送料も教えてください。お届け先は東京都です。" }),
  );

  assertEqual(callCount(state, "generateText"), 1, "回答漏れ: MISSINGを検出しても再生成は行わない(呼び出し回数は1のまま)");
  assertTrue(result.draftText != null, "回答漏れ: それでも下書き自体は返す(スタッフ確認付きの下書きとして)");
  const coverage = result.evidence.answerPlan?.coverage ?? [];
  assertTrue(
    coverage.some((c) => c.topic === "SHIPPING" && c.coverage === "MISSING"),
    "回答漏れ: 送料への言及漏れがMISSINGとしてevidenceに残る",
  );
  assertTrue(
    result.unresolvedFacts.length > unresolvedBefore &&
      result.unresolvedFacts.some((u) => u.field.includes("送料")),
    "回答漏れ: 未解決事実として「送料への回答」が積まれ、送信前確認を促す",
  );
}

/* ══════════════════════════════════════════════════════════════════
 * ケース3/5: 根拠のない値引きの約束は拒否され、REPLY_MAX_GENERATION_ATTEMPTS
 * まで再生成した末に失敗として返る(再生成の上限そのものの確認も兼ねる)
 * ══════════════════════════════════════════════════════════════════ */
async function testUngroundedDiscountIsRejectedUntilAttemptCap() {
  const state = installBaseMock({
    resolveNegotiation: async () => ({
      evidence: {
        detected: true,
        signals: ["(合成テスト用の交渉シグナル)"],
        quantity: null,
        requestedTotalPriceYen: 90_000,
        requestedUnitPriceYen: null,
        carriedOverFromHistory: false,
        awaitingDestination: false,
      },
      staffCard: null,
      // 根拠なし: negotiationServiceが値引き後価格を確定していない状態を模す
      // (verify-negotiation-service-boundary.tsが検証済みの契約どおり、
      // 商品価格のみ/送料のみではcustomerSafeFactsは空になる)。
      customerSafeFacts: [],
      customerQuestions: [],
      missing: [],
    }),
    // 毎回、根拠の無い値引きの約束を書き続けるAIを模す
    // (systemPromptにlastViolationsが積まれても直らない、という想定)。
    generateText: async () => ({
      output: "お値引きいたします。ご検討よろしくお願いいたします。",
      providerId: "anthropic",
      modelId: "test-model-ungrounded-discount",
    }),
  });

  const result = await generateInquiryReplyDraft(
    baseRequest({ messageText: "9万円になりませんか。" }),
  );

  assertEqual(
    callCount(state, "generateText"),
    3,
    "根拠なし値引き: REPLY_MAX_GENERATION_ATTEMPTS(3)回まで再生成し、そこで止まる",
  );
  assertEqual(result.status, "FAILED", "根拠なし値引き: 最終的にFAILEDとして返る(根拠の無い値引きをそのまま出さない)");
  assertEqual(result.draftText, null, "根拠なし値引き: draftTextは無い(根拠の無い約束を顧客へ出さない)");
  assertTrue(
    (result.failureReason ?? "").includes("3回"),
    "根拠なし値引き: failureReasonに再生成の上限に達したことが分かる説明が入る",
  );
}

/* ══════════════════════════════════════════════════════════════════
 * ケース4: negotiationServiceが実際に確定した値引き後価格があれば許容する
 * ══════════════════════════════════════════════════════════════════ */
async function testApprovedDiscountIsAllowed() {
  const state = installBaseMock({
    resolveNegotiation: async () => ({
      evidence: {
        detected: true,
        signals: ["(合成テスト用の交渉シグナル)"],
        quantity: null,
        requestedTotalPriceYen: 90_000,
        requestedUnitPriceYen: null,
        carriedOverFromHistory: false,
        awaitingDestination: false,
      },
      staffCard: { differenceFromRequestedYen: 1000 } as never,
      // 承認済み: negotiationServiceが値引き後価格を確定した状態を模す。
      customerSafeFacts: [{ label: "お値引き後のご提示価格(確定値)", value: "46,128円" }],
      customerQuestions: [],
      missing: [],
    }),
    generateText: async () => ({
      output: "お値引きいたします。46,128円でご案内いたします。",
      providerId: "anthropic",
      modelId: "test-model-approved-discount",
    }),
  });

  const result = await generateInquiryReplyDraft(
    baseRequest({ messageText: "9万円になりませんか。" }),
  );

  assertEqual(
    callCount(state, "generateText"),
    1,
    "承認済み値引き: 根拠(customerSafeFacts)があるので1回で通り、再生成しない",
  );
  assertTrue(result.draftText != null, "承認済み値引き: draftTextが生成される");
  assertEqual(result.status === "FAILED", false, "承認済み値引き: FAILEDにはならない");
}

/* ══════════════════════════════════════════════════════════════════
 * ケース6: 各試行でmodelProvider/modelNameが正しく更新される
 * (途中の試行が失敗しても、最終的に成功した試行の値が残る)
 * ══════════════════════════════════════════════════════════════════ */
async function testModelInfoTracksTheAttemptThatSucceeded() {
  const state = installBaseMock({
    resolveNegotiation: async () => ({
      evidence: {
        detected: true,
        signals: ["(合成テスト用の交渉シグナル)"],
        quantity: null,
        requestedTotalPriceYen: 90_000,
        requestedUnitPriceYen: null,
        carriedOverFromHistory: false,
        awaitingDestination: false,
      },
      staffCard: null,
      customerSafeFacts: [],
      customerQuestions: [],
      missing: [],
    }),
    generateText: async () => {
      // mock-hooks.mjsは呼び出しをimpl実行**前**にcalls配列へpushするため、
      // ここでのcallCountは「今回の呼び出し自身」を含む値になっている
      // (=そのままattempt番号として使える)。
      const attempt = callCount(state, "generateText");
      if (attempt < 3) {
        return {
          output: "お値引きいたします。",
          providerId: "anthropic",
          modelId: `test-model-attempt-${attempt}`,
        };
      }
      // 3回目でようやく根拠の無い約束を含まない文章に直った、という想定。
      return {
        output: "恐れ入りますが、こちらは値引き対応が確定しておりません。",
        providerId: "anthropic",
        modelId: `test-model-attempt-${attempt}`,
      };
    },
  });

  const result = await generateInquiryReplyDraft(
    baseRequest({ messageText: "9万円になりませんか。" }),
  );

  assertEqual(callCount(state, "generateText"), 3, "各試行のusage: 1・2回目は不合格、3回目で通るまで3回呼ばれる");
  assertEqual(result.modelName, "test-model-attempt-3", "各試行のusage: 最終結果には成功した試行(3回目)のmodelNameが残る");
  assertTrue(result.draftText != null, "各試行のusage: 3回目の内容で下書きが生成される");
}

/* ══════════════════════════════════════════════════════════════════
 * ケース7: AnswerPlan生成後検査の不合格ログに識別子が出ない(動的確認)
 *
 * scripts/verify-inquiry-answer-plan.ts のtestNoNewIdentifierInAnswerPlan
 * FailureLogはソースコードの静的検査だが、ここでは実際にconsole.warnを
 * 差し替えて実行時に捕まえた引数そのものを検査する。
 * ══════════════════════════════════════════════════════════════════ */
async function testAnswerPlanFailureLogHasNoIdentifiers() {
  const state = installBaseMock({
    resolveNegotiation: async () => ({
      evidence: {
        detected: true,
        signals: ["(合成テスト用の交渉シグナル)"],
        quantity: null,
        requestedTotalPriceYen: 90_000,
        requestedUnitPriceYen: null,
        carriedOverFromHistory: false,
        awaitingDestination: false,
      },
      staffCard: null,
      customerSafeFacts: [],
      customerQuestions: [],
      missing: [],
    }),
    generateText: async () => ({
      output: "お値引きいたします。",
      providerId: "anthropic",
      modelId: "test-model-log-check",
    }),
  });

  const captured: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    captured.push(args);
  };
  const conversationId = "conv-should-not-leak-into-logs";
  const messageText = "9万円になりませんか。(この原文がログに残ってはいけない)";
  try {
    await generateInquiryReplyDraft(baseRequest({ conversationId, messageText }));
  } finally {
    console.warn = originalWarn;
  }

  assertEqual(callCount(state, "generateText"), 3, "識別子ログ: 前提として3回とも不合格になっている");
  const answerPlanWarnings = captured.filter((args) =>
    typeof args[0] === "string" && args[0].includes("[inquiryReply] AnswerPlanの生成後検査で不合格"),
  );
  assertTrue(answerPlanWarnings.length > 0, "識別子ログ: AnswerPlan生成後検査の不合格ログが実際に出力される");
  const serialized = JSON.stringify(answerPlanWarnings);
  assertTrue(!serialized.includes(conversationId), "識別子ログ: conversationIdがログに含まれない");
  assertTrue(!serialized.includes(messageText), "識別子ログ: 顧客原文がログに含まれない");
}

async function main() {
  await testNormalSingleGeneration();
  await testMissingAnswerDoesNotTriggerRegeneration();
  await testUngroundedDiscountIsRejectedUntilAttemptCap();
  await testApprovedDiscountIsAllowed();
  await testModelInfoTracksTheAttemptThatSucceeded();
  await testAnswerPlanFailureLogHasNoIdentifiers();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
