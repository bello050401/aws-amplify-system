import "server-only";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { getBedrockModelForTier, getBedrockModelById } from "./modelRegistry";
import type { AIGatewayProvider, AIGeneratePolicy, AIGenerateResult, AITask, AITokenUsage, AIToolSchema } from "./types";

/**
 * 夜間長時間・全課題解決指示書 §6: 商品説明の自動生成が
 * 「ANTHROPIC_API_KEYが設定されていません。」で止まる状態の是正。
 *
 * 利用者の意図は「AWSのAIで生成する」であり、BELLOのアプリは既にAWS
 * (Amplify Hosting SSR / Lambda)の上でIAMロールを持って動いている。
 * このProviderは、そのIAMロールの資格情報をそのまま使ってAmazon
 * Bedrock経由でモデルを呼ぶ — 別途APIキーを発行・保管する必要がない。
 *
 * ## 設計
 *
 * `AnthropicGatewayProvider`と同じ`AIGatewayProvider`を実装するだけで、
 * Router・品質ゲート・UsageLog・呼び出し側(lib/ai/ecCopy.ts等)は一切
 * 変更しない — 既存のGateway抽象がまさにこのために用意されていた
 * (gateway.tsの「将来Provider追加時、ここのswitchを増やすだけでよい
 * 設計」というコメント)。
 *
 * モデルIDはコードへ散在させず`modelRegistry.ts`のBedrock用エントリ
 * だけで管理する(§6-6「model IDはコードに散在させず設定化」)。
 *
 * ## リージョン
 *
 * `BEDROCK_REGION` > `AWS_REGION` > 既定`us-west-2`(Staging/Production
 * のAmplify Appと同じリージョン)。Bedrockはリージョンごとに使える
 * モデルが異なるため、明示的に上書きできるようにしてある。
 *
 * ## 現時点の外部ブロッカー(実測)
 *
 * このAWSアカウント(203918843421)では、2026-08-31時点でBedrockの
 * `Converse`がモデルを問わず以下で拒否される:
 *
 *   AccessDeniedException: Your account is currently being verified.
 *   Verification normally takes less than 2 hours.
 *
 * これはモデルアクセス許諾の問題ではなく**AWS側のアカウント検証待ち**
 * であり、コードでは解消できない。検証が完了すればこのProviderはその
 * まま動作する(コード側は完成させ、外部要因だけを分離する — 指示書
 * §6-13の方針)。`healthCheck()`はこの状態を利用者に分かる言葉で返す。
 */

function client(): AnthropicBedrockMantle {
  const awsRegion = process.env.BEDROCK_REGION || process.env.AWS_REGION || "us-west-2";
  // 資格情報は明示的に渡さない — Amplify SSRコンピュート/Lambdaの実行
  // ロール(既定の資格情報プロバイダチェーン)を使う。APIキーもSecretも
  // 増やさない。
  return new AnthropicBedrockMantle({ awsRegion });
}

/**
 * 利用者に見せて安全な説明へ変換する。
 *
 * **上流のメッセージ本文は決して混ぜない。** AWSの権限エラーは本文へ
 * 実行ロールのARN・ロール名・拒否されたアクション名・request_idを含めて
 * 返してくる。実際に画面へ次のような文字列がそのまま出ていた:
 *
 *   403 {"type":"error","request_id":"req_...","error":{"type":
 *   "permission_error","message":"User: arn:aws:sts::<account>:assumed-role/
 *   <RoleName>/AmplifyHostingCompute-app=<appId> is not authorized to
 *   perform: bedrock-mantle:CreateInference ..."}}
 *
 * アカウントID・ロール名・アプリIDを利用者向け画面へ出す必要は無い。
 * 詳細は呼び出し元がconsole.errorでサーバーログへ落としているので、
 * ここでは分類した日本語だけを返す。
 */
export function describeBedrockError(err: unknown): string {
  const name = (err as { name?: string } | null)?.name ?? "";
  const status = (err as { status?: number } | null)?.status;
  const message = err instanceof Error ? err.message : String(err);
  const haystack = `${name} ${message}`;

  // アカウント検証待ちは権限不足と区別する — 利用者側で対処のしようが
  // 無く、AWS側の手続き完了で自動的に解消するため。
  if (/being verified|account is currently being verified/i.test(haystack)) {
    return "AWSアカウントの検証が完了していないため、Amazon Bedrockをまだ利用できません（AWS側の手続きが完了すると自動的に利用可能になります）。";
  }
  // permission_error はAnthropicのBedrockクライアントが403で返す型名。
  // AccessDeniedExceptionはAWS SDK側の名前。どちらも権限不足。
  if (status === 403 || /AccessDenied|permission_error|not authorized to perform/i.test(haystack)) {
    return "Amazon Bedrockを呼び出す権限がありません。実行ロールに推論の権限が付与されているかをご確認ください（詳細はサーバーログに記録しています）。";
  }
  if (status === 429 || /Throttl|TooManyRequests|rate_limit/i.test(haystack)) {
    return "Amazon Bedrockが混雑しています。少し時間をおいて再度お試しください。";
  }
  if (status === 400 || /ValidationException|invalid_request/i.test(haystack)) {
    return "Amazon Bedrockへのリクエスト内容が不正でした（モデルIDまたはパラメータをご確認ください）。";
  }
  if (status === 404 || /not_found_error|ResourceNotFound/i.test(haystack)) {
    return "指定したモデルがこのリージョンで見つかりませんでした（モデルIDとリージョンの組み合わせをご確認ください）。";
  }
  return "Amazon Bedrockの呼び出しに失敗しました。時間をおいて再度お試しください（詳細はサーバーログに記録しています）。";
}

const THINKING = { type: "adaptive" } as const;

export class BedrockGatewayProvider implements AIGatewayProvider {
  readonly providerId = "bedrock";

  async healthCheck(): Promise<{ ok: boolean; message: string }> {
    // 実際の推論は課金が発生するため、healthCheckでは呼び出さない
    // (AnthropicGatewayProviderと同じ方針)。設定の有無だけを返す。
    const region = process.env.BEDROCK_REGION || process.env.AWS_REGION;
    if (!region) {
      return { ok: false, message: "リージョンが特定できません（BEDROCK_REGION または AWS_REGION を設定してください）。" };
    }
    return {
      ok: true,
      message: `Amazon Bedrock（${region}）を使用する設定です。実行ロールの資格情報で呼び出します（APIキーは不要）。実際の疎通確認は呼び出しコストを避けるため行っていません。`,
    };
  }

  estimateCost(modelId: string, usage: AITokenUsage): number | null {
    const model = getBedrockModelById(modelId);
    if (!model || model.costPerMillionInputTokensUsd == null || model.costPerMillionOutputTokensUsd == null) return null;
    return (usage.inputTokens / 1_000_000) * model.costPerMillionInputTokensUsd + (usage.outputTokens / 1_000_000) * model.costPerMillionOutputTokensUsd;
  }

  async generateText(task: AITask, systemPrompt: string, userPrompt: string, policy: AIGeneratePolicy): Promise<AIGenerateResult<string>> {
    const model = getBedrockModelForTier(policy.tier);
    const startedAt = Date.now();
    let res;
    try {
      res = await client().messages.create({
        model: model.modelId,
        max_tokens: policy.maxTokens ?? model.maxOutputTokens,
        thinking: THINKING,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      });
    } catch (err) {
      console.error(`[BedrockGatewayProvider.generateText] task=${task} failed:`, err);
      throw new Error(describeBedrockError(err));
    }
    const textBlock = res.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") throw new Error("AI応答にテキスト出力が含まれていませんでした。");

    return {
      output: textBlock.text.trim(),
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
      latencyMs: Date.now() - startedAt,
      providerId: this.providerId,
      modelId: model.modelId,
      qualityTier: policy.tier,
      fallbackOccurred: false,
      qualityGatePassed: true, // Router側で上書きする(AnthropicGatewayProviderと同じ)
      qualityGateViolations: [],
    };
  }

  async generateStructured<T>(
    task: AITask,
    systemPrompt: string,
    userPrompt: string,
    toolSchema: AIToolSchema,
    policy: AIGeneratePolicy,
  ): Promise<AIGenerateResult<T>> {
    const model = getBedrockModelForTier(policy.tier);
    const startedAt = Date.now();
    let res;
    try {
      res = await client().messages.create({
        model: model.modelId,
        max_tokens: policy.maxTokens ?? model.maxOutputTokens,
        thinking: THINKING,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        tools: [toolSchema],
        tool_choice: { type: "tool", name: toolSchema.name },
      });
    } catch (err) {
      console.error(`[BedrockGatewayProvider.generateStructured] task=${task} failed:`, err);
      throw new Error(describeBedrockError(err));
    }
    const toolUse = res.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") throw new Error("AI応答に期待した構造化出力が含まれていませんでした。");

    return {
      output: toolUse.input as T,
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
      latencyMs: Date.now() - startedAt,
      providerId: this.providerId,
      modelId: model.modelId,
      qualityTier: policy.tier,
      fallbackOccurred: false,
      qualityGatePassed: true,
      qualityGateViolations: [],
    };
  }
}
