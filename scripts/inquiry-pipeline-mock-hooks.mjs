/**
 * generateInquiryReplyDraft(lib/inquiry/pipeline.ts)全体を、外部境界
 * (実AI・実DynamoDB・実Web検索・BASE API)だけ差し替えて実行するための
 * プロセス内ロードhook(Node組み込みのモジュールカスタマイズフック)。
 *
 * ── 何のためにあるか ────────────────────────────────────────────────
 *
 * これまでのverify:inquiry-answer-plan(純粋関数のみ)とverify:negotiation-
 * service-boundary(negotiationServiceの境界だけ)は、generateInquiryReplyDraft
 * 全体を実際に1回通して検証するものではなかった。このhookは、pipeline.ts
 * が直接importしている外部境界モジュールだけを合成モジュールへ差し替え、
 * それ以外(answerPlan.ts・validate.ts・negotiation.ts・productContext.ts等の
 * 判定ロジック)はすべて原本のファイルをそのまま読み込ませる。
 *
 * ── なぜnode_modulesを書き換えないか(scripts/with-server-only-stub-native.cjs
 *    の旧実装からの変更点) ──────────────────────────────────────────
 *
 * 旧実装は"server-only"パッケージの実体(node_modules/server-only/index.js)
 * を一時的に書き換えて実行後に戻していた。これは共有のnode_modules
 * (他のworktree・他のプロセスと共有されうる)への書き込みを伴い、並行実行中の
 * 別プロセスが書き換え中の内容を読んでしまうレースの可能性がある。
 * このhookは"server-only"という**指定子の解決結果だけ**をプロセス内で
 * 差し替える(disk上のファイルには一切触れない)。差し替えはこのNode
 * プロセスの中だけで完結し、他のプロセス・他のworktreeには一切影響しない。
 *
 * ── 差し替える指定子(pipeline.tsが直接importするものだけ) ────────────
 *
 *   - "server-only"                 : どのファイルからのimportでも空にする
 *                                      (server-onlyパッケージは"react-server"
 *                                      export conditionの外では常にthrowする
 *                                      実装のため、Next.js実行環境の外から
 *                                      importできるようにするための無害化)
 *   - "@/lib/ai/gateway/gateway"     : generateText(実AI呼び出し)
 *   - "@/lib/inventory/queries"      : getInventoryDetail/listCategories/
 *                                      listStatuses(実DynamoDB接続)
 *   - "@/lib/shipping/service"       : lookupShippingRate(実DynamoDB接続)
 *   - "@/lib/knowledge/store"        : listSearchableKnowledge(実DynamoDB
 *                                      接続。next/headersも引き込むため
 *                                      なおさら差し替えが要る)
 *   - "./settings"                   : getAIReplySettings(実DynamoDB接続)
 *   - "./productResolver"            : resolveProductFromInquiry(在庫の
 *                                      全件スキャン等、実DynamoDB接続)
 *   - "./negotiationService"         : resolveNegotiation(実DynamoDB接続。
 *                                      その内部契約はscripts/
 *                                      verify-negotiation-service-boundary.ts
 *                                      が別途検証している。ここでは
 *                                      pipeline.ts側の受け取り方だけを見る)
 *   - "./baseProductLookup"          : lookupBaseProduct/lookupBaseProducts
 *                                      (BASE API・実DynamoDB接続。
 *                                      productContext.tsが内部で使う)
 *   - "./replyRuleStore"             : listActiveReplyRules(実DynamoDB接続)
 *   - "./research/service"           : researchMissingFacts等(実Web fetch)
 *   - "./research/agentCoreProvider" : createAgentCoreSearchProvider(実AWS
 *                                      Bedrock AgentCore呼び出し)
 *
 * これ以外(answerPlan.ts, validate.ts, negotiation.ts, productContext.ts,
 * productDetailExtraction.ts, conversationContext.ts, pendingAnswer.ts,
 * scoring.ts, references.ts, intent.ts, shippingIntent.ts, prompt.ts,
 * discount.ts, replyRuleSelection.ts, productIdentification.ts, types.ts,
 * @/lib/shipping/rank, @/lib/inventory/imageTypes, @/lib/ai/productIntro/facts
 * 等)は"server-only"も"next/headers"もamplifyのDBクライアントも直接
 * importしないことを確認済み(調査記録は呼び出し側のverifyスクリプトの
 * コメント参照)なので、原本のファイルをそのまま実行する。
 *
 * ── 合成モジュールの実装方法 ─────────────────────────────────────────
 *
 * 各合成モジュールは、実際の処理を globalThis.__inquiryPipelineMock.impl
 * (テスト側がシナリオごとに差し替える)へ委譲し、呼び出しを
 * globalThis.__inquiryPipelineMock.calls へ記録する。合成モジュールの
 * ソースコードは`load`フックの中で文字列として生成し、Nodeへ**通常の
 * ESモジュール**として評価させる(このプロセスのメインの実行コンテキスト
 * で評価されるため、globalThisは呼び出し側のテストスクリプトと共有される)。
 *
 * Usage: node --experimental-strip-types \
 *   --experimental-loader ./scripts/inquiry-pipeline-mock-hooks.mjs \
 *   scripts/verify-inquiry-pipeline-boundary.ts
 */
import { resolve as extResolve } from "./_ts-extension-loader.mjs";

const MOCK_SCHEME = "inquiry-pipeline-mock:";

/**
 * 指定子 → (a)合成モジュールのexport名一覧、(b) globalThis.__inquiryPipelineMock.impl
 * に置く関数名のマップ。exportの名前はpipeline.ts(またはproductContext.ts)が
 * 実際にimportしている名前と一致させる。
 */
const MOCK_MODULES = {
  "server-only": { exportNames: [], defaultExport: true },
  "@/lib/ai/gateway/gateway": { exportNames: ["generateText"] },
  "@/lib/inventory/queries": { exportNames: ["getInventoryDetail", "listCategories", "listStatuses"] },
  "@/lib/shipping/service": { exportNames: ["lookupShippingRate", "listShippingRates"] },
  "@/lib/knowledge/store": { exportNames: ["listSearchableKnowledge"] },
  "./settings": { exportNames: ["getAIReplySettings"] },
  "./productResolver": { exportNames: ["resolveProductFromInquiry", "clearProductResolverCache"] },
  "./negotiationService": { exportNames: ["resolveNegotiation", "evaluateOfficialLinePaymentCondition"] },
  "./baseProductLookup": { exportNames: ["lookupBaseProduct", "lookupBaseProducts"] },
  "./replyRuleStore": { exportNames: ["listActiveReplyRules"] },
  "./research/service": {
    exportNames: ["getAgentCoreGatewayUrl", "getWebResearchAvailability", "createDirectUrlProvider", "researchMissingFacts"],
  },
  "./research/agentCoreProvider": { exportNames: ["createAgentCoreSearchProvider"] },
};

/**
 * 相対指定子("./x")は、importしたファイルによって解決先が変わりうる
 * (例: "./settings"はpipeline.tsから見ればlib/inquiry/settings.tsだが、
 * 他のファイルから見れば別物になりうる)。ここではlib/inquiry/配下からの
 * 相対import専用と割り切り、指定子の文字列そのものをキーにする
 * (pipeline.ts・productContext.tsはどちらもlib/inquiry/直下にあるため、
 * "./settings"のようなキーは両者から見て同じ解決先を指す)。
 */
function findMockEntry(specifier) {
  return MOCK_MODULES[specifier] ?? null;
}

export async function resolve(specifier, context, nextResolve) {
  const entry = findMockEntry(specifier);
  if (entry) {
    return { url: `${MOCK_SCHEME}${specifier}`, format: "module", shortCircuit: true };
  }
  return extResolve(specifier, context, nextResolve);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith(MOCK_SCHEME)) {
    const specifier = url.slice(MOCK_SCHEME.length);
    const entry = findMockEntry(specifier);
    if (!entry) throw new Error(`inquiry-pipeline-mock-hooks: unknown mock specifier ${specifier}`);
    return { format: "module", source: buildMockSource(specifier, entry), shortCircuit: true };
  }
  return nextLoad(url, context);
}

/**
 * 合成モジュールのソース。呼び出しを記録しつつ、実処理は
 * globalThis.__inquiryPipelineMock.impl[key] へ委譲する。
 *
 * 【呼び出し時に毎回globalThisを参照する】モジュール評価時(import時)
 * ではなく呼び出し時に参照することで、テスト側がシナリオごとに
 * globalThis.__inquiryPipelineMock.impl を差し替えるだけで、
 * 同じ合成モジュールインスタンスのまま挙動を変えられる
 * (Nodeは同一URLのモジュールを1度しか評価しないため)。
 */
function buildMockSource(specifier, entry) {
  if (specifier === "server-only") {
    return "export default {};\n";
  }
  const fns = entry.exportNames
    .map((name) => {
      const nameJson = JSON.stringify(name);
      // メッセージ全体を先にJSON.stringifyしてから埋め込む(specifier/name
      // 自体に含まれる二重引用符を、生成するソースコードの中で正しく
      // エスケープさせるため)。
      const notSetMsg = JSON.stringify(
        `inquiry-pipeline-mock-hooks: globalThis.__inquiryPipelineMock is not set (call installBaseMock() first) for ${specifier} / ${name}`,
      );
      const noImplMsg = JSON.stringify(`inquiry-pipeline-mock-hooks: no impl registered for ${specifier} / ${name}`);
      return `export function ${name}(...args) {
  const mock = globalThis.__inquiryPipelineMock;
  if (!mock) throw new Error(${notSetMsg});
  (mock.calls[${nameJson}] ??= []).push(args);
  const impl = mock.impl[${nameJson}];
  if (!impl) throw new Error(${noImplMsg});
  return impl(...args);
}`;
    })
    .join("\n\n");
  return fns + "\n";
}
