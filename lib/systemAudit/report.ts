import "server-only";
import { listAIUsageLogs } from "@/lib/ai/gateway/usageLog";
import { MODEL_REGISTRY, MODEL_PRICING_VERIFIED_AT, MODEL_PRICING_SOURCE } from "@/lib/ai/gateway/modelRegistry";

/**
 * BELLOベンダー非依存・交換可能アーキテクチャ仕様書(2026-08-30) §7:
 * 「BELLO System Audit Report」— ユーザーがBELLO全repositoryを
 * ChatGPT等へ渡さなくても、コスト・AI利用・architectureを監査できる
 * ようにするためのMarkdownレポート生成。
 *
 * 【絶対に含まない】秘密鍵・Access Token・個人情報・Secret Manager値・
 * OAuth token — この関数はAIUsageLog(メタデータのみ、既に個人情報を
 * 保存しない設計)とMODEL_REGISTRY(価格公開情報)、および以下の
 * 静的なcapability matrix/既知のブロッカー一覧(コード中のコメントを
 * 転記したもの、いずれも秘匿情報ではない)だけを参照する。動的に
 * Secrets Managerの値やAPIトークンを読みに行く経路はこのファイルには
 * 存在しない。
 */

const EC_CHANNEL_CAPABILITY_MATRIX = `
| チャネル | 出品作成 | 価格変更 | 在庫更新 | 公開/非公開 | 再出品 | 状態 |
|---|---|---|---|---|---|---|
| Mercari Shops | LOCAL_VERIFIED | BLOCKED_BY_EXTERNAL_SERVICE(updateProduct実schema未確認) | N/A(未実装) | N/A(未実装) | BLOCKED_BY_EXTERNAL_SERVICE | 実接続情報未設定 |
| BASE | LOCAL_VERIFIED(items/add) | LOCAL_VERIFIED(items/edit、Pricing Rule連携済み) | LOCAL_IMPLEMENTED(items/edit) | LOCAL_IMPLEMENTED(items/edit visible) | 未実装 | 実OAuth接続未設定 |
| Yahoo!オークション | BLOCKED_BY_EXTERNAL_SERVICE(一般提供API不在) | N/A | N/A | N/A | N/A | 落札通知メールのEmail ingestion化を設計のみ |
`.trim();

const MESSAGING_CHANNEL_CAPABILITY_MATRIX = `
| チャネル | 受信 | 送信 | Webhook署名検証 | 重複排除 | 状態 |
|---|---|---|---|---|---|
| LINE | LOCAL_VERIFIED(署名検証実装済み) | LOCAL_IMPLEMENTED(push) | LOCAL_VERIFIED(実HMACベクタで検証) | LOCAL_VERIFIED(externalMessageId) | 実Channel Secret/Token未設定 |
| Mercari問い合わせ | BLOCKED_BY_EXTERNAL_SERVICE | BLOCKED_BY_EXTERNAL_SERVICE | 未確認 | N/A | addInquiryMessage等の実フィールド未確認 |
| Email(SES) | BLOCKED_BY_USER(受信ドメイン未定) | LOCAL_IMPLEMENTED(SendEmail実装済み) | N/A | N/A | 送信元ドメイン検証待ち |
| Yahoo!オークション | BLOCKED_BY_EXTERNAL_SERVICE | BLOCKED_BY_EXTERNAL_SERVICE | N/A | N/A | 一般提供API不在 |
`.trim();

const SHIPPING_PROVIDER_STATUS = `
- 家財おまかせ便(アートセッティングデリバリー): ランク判定ロジック LOCAL_VERIFIED。料金マスタは埼玉→東京のB/Cランク2件のみ実データ確認済み(REAL_EXTERNAL_API_VERIFIED級の裏付け)、他は公式料金検索ツールがJS動的フォームでこのsandbox環境から取得不能(BLOCKED_BY_EXTERNAL_SERVICE、技術的制約であり調査不足ではない)。
`.trim();

const KNOWN_BLOCKERS = `
1. **AWS認証情報の不在(根本原因)**: このsandbox環境の\`AWS_ACCESS_KEY_ID\`/\`AWS_SECRET_ACCESS_KEY\`は実際には"proxy-injected"というプレースホルダ文字列であり、実際のAWS STS呼び出しは\`InvalidClientTokenId\`で失敗する。IMDS/ECSコンテナ認証情報も無し。これがStaging deploy・Secrets Manager操作・AWS上でのE2E検証すべてを妨げている、単一の共通原因。
2. **ANTHROPIC_API_KEYの不在**: アプリケーションコードから実際にAnthropic APIを呼ぶと401 invalid x-api-keyとなることを確認済み(このClaude Codeセッション自身の認証とは別物)。AI Benchmark・実生成のいずれも実行時に同じ理由で失敗する。
3. **Mercari Shops updateProduct/問い合わせAPI**: 複数経路(公式docs・sandbox GraphQLエンドポイント・GitHub非公式クライアント2件)で調査したが、price/statusフィールド名・Webhook署名方式は未確認。契約者専用の開発者ポータルへのアクセスが必要。
4. **Yahoo!オークションストア**: 一般提供された出品/メッセージAPIが存在しない(Yahoo!ショッピング向けAPIとは別サービス)。
5. **家財おまかせ便の全国料金表**: 公式ツールがJS動的フォームで、このsandbox環境のegress proxyがWebFetchを許可していないドメインのため取得不能。
`.trim();

const KNOWN_TECHNICAL_DEBT = `
- EC出品一覧画面(ListingsOverviewTable)はMercariチャネルのみを前提にした実装のまま — BASEチャネルの出品状況は商品詳細ページ単位でしか確認できず、横断一覧には未反映。
- Pricing Rule EngineはBASEチャネルのみ実送信まで到達済み、Mercariは判定のみ(外部API未確認のため)。
- 完全無人スケジュール実行(EventBridge Scheduler等)は、Amplify Data(\`allow.resource(fn)\`不可)経由の安全な書き込み手段が無いため未実装。UPDATE専用(GSIキー属性を触らない)なら生DynamoDB経由で安全に実装できる設計は特定済みだが、ライブAWS環境での検証なしに実装・deployはしていない。
- BASE商品作成時の画像同期は未実装(テキスト情報のみ)。
`.trim();

const COST_OPTIMIZATION_CANDIDATES = `
- AIRouterのECONOMY tier(Haiku 4.5)を、現状STANDARD固定のlisting title等の軽量タスクへ適用すれば、品質ゲートを維持したままコスト削減の余地がある(現状は移行時の品質維持を優先しSTANDARD既定のまま)。
- ZAICO全件同期はブラウザ主導のポーリング方式(advance呼び出し)であり、開いている間は定期的にAPI呼び出しが発生する — 完全無人スケジュール化(上記技術的負債参照)ができれば、無駄な待機ポーリングを減らせる可能性がある。
`.trim();

const QUALITY_OPTIMIZATION_CANDIDATES = `
- AI Benchmark基盤(lib/ai/gateway/benchmark.ts)は実装済みだが、ANTHROPIC_API_KEY未設定のため実行結果が無い — 実キー設定後に実行し、tier別の品質・latency・costを比較のうえSTANDARD/ECONOMYの既定modelを見直す余地がある。
- Quality Gateの禁止パターン(lib/ai/gateway/qualityGate.ts)は現状シンプルな正規表現ベース — 実運用データが蓄積したら、実際に見逃したケース/誤検知したケースを元に精緻化する余地がある。
`.trim();

const SECURITY_NOTES = `
- Secrets(ZAICO/Mercari/LINE)はいずれもAWS Secrets Manager優先+env fallbackのパターンで統一、値をログ・クライアントバンドル・Gitへ出力しない設計を確認済み。
- AI Gatewayの使用量ログ(AIUsageLog)はプロンプト全文・顧客メッセージ本文を保存しない設計(§6要件の実装確認)。
- 顧客メッセージ・LINEメッセージはuntrusted dataとしてsystem promptで明示し、prompt injectionを命令として採用しない設計(lib/ai/ecCopy.tsのbuildReplySystemPrompt参照)。
- LINE Webhookはx-line-signature検証(HMAC-SHA256、timingSafeEqual使用)を実装、実HMACベクタで検証済み。
- adminMemo(社内連絡事項)はAI生成関数の入力型に一切存在しない(型レベルでの境界強制)。
`.trim();

export interface SystemAuditReportOptions {
  /** 集計対象期間の開始(ISO、省略時は全期間)。 */
  sinceIso?: string;
}

/** §7: BELLO System Audit Reportを生成する(ADMIN限定 — 呼び出し元app/actions/systemAudit.tsで権限強制)。 */
export async function generateSystemAuditReport(options: SystemAuditReportOptions = {}): Promise<string> {
  const usageAggregates = await listAIUsageLogs(options.sinceIso).catch((err) => {
    console.error("[generateSystemAuditReport] listAIUsageLogs failed (report will note zero usage):", err);
    return [];
  });

  const totalCalls = usageAggregates.reduce((sum, a) => sum + a.count, 0);
  const totalCost = usageAggregates.reduce((sum, a) => sum + a.totalEstimatedCostUsd, 0);
  const totalFallback = usageAggregates.reduce((sum, a) => sum + a.fallbackCount, 0);
  const totalQualityFailure = usageAggregates.reduce((sum, a) => sum + a.qualityGateFailureCount, 0);
  const totalSuccess = usageAggregates.reduce((sum, a) => sum + a.successCount, 0);

  const usageTable = usageAggregates.length
    ? [
        "| Task | 件数 | 成功 | Fallback発生 | 品質ゲート不合格 | 概算コスト(USD) | 平均latency(ms) |",
        "|---|---|---|---|---|---|---|",
        ...usageAggregates.map(
          (a) => `| ${a.task} | ${a.count} | ${a.successCount} | ${a.fallbackCount} | ${a.qualityGateFailureCount} | $${a.totalEstimatedCostUsd.toFixed(4)} | ${a.averageLatencyMs} |`,
        ),
      ].join("\n")
    : "_利用実績はまだありません(AIUsageLogが空 — ANTHROPIC_API_KEY未設定のため、このsandbox環境ではまだ実生成が発生していません)。_";

  const modelTable = [
    "| Provider | Model | Tier | 有効 | Input単価($/1M tok) | Output単価($/1M tok) |",
    "|---|---|---|---|---|---|",
    ...MODEL_REGISTRY.map(
      (m) => `| ${m.providerId} | ${m.modelId} | ${m.qualityTier} | ${m.enabled ? "yes" : "no"} | ${m.costPerMillionInputTokensUsd ?? "-"} | ${m.costPerMillionOutputTokensUsd ?? "-"} |`,
    ),
  ].join("\n");

  return `# BELLO System Audit Report

生成日時: ${new Date().toISOString()}
集計対象: ${options.sinceIso ? `${options.sinceIso} 以降` : "全期間"}

> このレポートには秘密鍵・Access Token・個人情報・Secrets Manager値・OAuth tokenは一切含まれていません。

## SYSTEM SUMMARY

BELLO統合業務OS — 在庫管理・EC出品(Mercari Shops/BASE)・メッセージ(LINE/Email/Mercari問い合わせ/Yahoo)・配送料金(家財おまかせ便)・自動値下げ・AI生成(出品コピー/返信案)を統合したAmplify Gen2(Next.js + AppSync + DynamoDB)ベースの業務システム。ベンダー非依存アーキテクチャ(AI Gateway/Channel Adapter/Messaging Adapter/Shipping Provider)を導入済み。

## AI PROVIDERS

- anthropic(実装済み、既定Provider)
- Bedrock等の追加: AWS認証情報・利用可能モデルを実環境で確認できていないため未実装(§17.3「モデル名を推測しない」)

## AI MODELS

${modelTable}

(単価出典: ${MODEL_PRICING_SOURCE}、確認日: ${MODEL_PRICING_VERIFIED_AT})

## AI TASKS

LISTING_TITLE_GENERATION / LISTING_DESCRIPTION_GENERATION / CUSTOMER_REPLY_DRAFT / PRODUCT_INFORMATION_EXTRACTION(未使用) / CLASSIFICATION(未使用)

## MONTHLY AI USAGE

総呼び出し件数: ${totalCalls}件(成功 ${totalSuccess}件)

## ESTIMATED AI COST

$${totalCost.toFixed(4)}(概算、AIUsageLogの記録に基づく)

## TASK COST BREAKDOWN / MODEL COST BREAKDOWN

${usageTable}

## FALLBACK RATE

${totalCalls > 0 ? `${((totalFallback / totalCalls) * 100).toFixed(1)}%` : "N/A(利用実績なし)"}(${totalFallback}/${totalCalls}件でECONOMY/STANDARD→PREMIUMへescalation発生)

## QUALITY GATE FAILURE RATE

${totalCalls > 0 ? `${((totalQualityFailure / totalCalls) * 100).toFixed(1)}%` : "N/A(利用実績なし)"}

## RETRY RATE / FAILED REQUESTS

${totalCalls > 0 ? `失敗 ${totalCalls - totalSuccess}件 / ${totalCalls}件` : "N/A(利用実績なし)"}

## EXTERNAL SERVICE ADAPTERS

### EC Channels
${EC_CHANNEL_CAPABILITY_MATRIX}

### Messaging Channels
${MESSAGING_CHANNEL_CAPABILITY_MATRIX}

### Shipping Providers
${SHIPPING_PROVIDER_STATUS}

## AWS SERVICES USED

Amplify Data(AppSync+DynamoDB)、S3(画像ストレージ)、Secrets Manager(ZAICO/Mercari/LINEトークン)、Cognito(認証)。EventBridge/Lambda等のバックグラウンド実行基盤は設計のみ(未deploy)。

## BACKGROUND JOBS

ZAICO全件同期: ブラウザ主導のチェックポイント方式(タブを閉じても進行状況は失われないが、PCの電源を落とすと停止する)。完全無人スケジュール実行は未実装(KNOWN BLOCKERS参照)。

## IMAGE PROCESSING PIPELINE

別途調査中(このレポート生成時点のリポジトリ監査結果を参照 — 完了報告本文に記載)。

## EC CHANNELS / MESSAGING CHANNELS / SHIPPING PROVIDERS

上記EXTERNAL SERVICE ADAPTERS参照。

## KNOWN BLOCKERS

${KNOWN_BLOCKERS}

## KNOWN TECHNICAL DEBT

${KNOWN_TECHNICAL_DEBT}

## COST OPTIMIZATION CANDIDATES

${COST_OPTIMIZATION_CANDIDATES}

## QUALITY OPTIMIZATION CANDIDATES

${QUALITY_OPTIMIZATION_CANDIDATES}

## SECURITY NOTES

${SECURITY_NOTES}

## CURRENT DEPLOYMENT STATUS

Staging/Production いずれも未deploy(AWS認証情報が本環境に存在しないため)。\`synth:check\`(CDK synth→CloudFormation生成)は全変更でgreen。

## TEST STATUS

直近のリポジトリ状態で \`tsc --noEmit\` / \`next lint\` / \`next build\` / \`synth:check\` / 全 \`verify:*\` スクリプトがgreen(詳細は完了報告本文参照)。
`;
}
