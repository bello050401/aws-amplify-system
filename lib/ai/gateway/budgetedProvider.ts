import "server-only";
import { reservePaidAttempt, settlePaidAttempt, PaidAIBudgetError } from "./commonBudget";
import { NovaGatewayProvider, novaModelForTier, novaOutputLimit } from "./novaProvider";
import type { AIGatewayProvider, AIGeneratePolicy, AIGenerateResult, AITask, AIToolSchema, AITokenUsage } from "./types";

/** Wrap each router attempt, including escalation. No process-local allowance. */
export class BudgetedGatewayProvider implements AIGatewayProvider {
  readonly providerId: string;
  constructor(private readonly inner: AIGatewayProvider,
    private readonly budget = { reservePaidAttempt, settlePaidAttempt }) { this.providerId = inner.providerId; }
  healthCheck() { return this.inner.healthCheck(); }
  estimateCost(modelId: string, usage: AITokenUsage) { return this.inner.estimateCost(modelId, usage); }
  private async run<T>(system: string, user: string, policy: AIGeneratePolicy, tool: AIToolSchema | undefined, execute: (policy: AIGeneratePolicy) => Promise<AIGenerateResult<T>>): Promise<AIGenerateResult<T>> {
    // Unsupported providers must not bypass the common cap through configuration.
    if (!(this.inner instanceof NovaGatewayProvider)) throw new PaidAIBudgetError("unsupported_provider");
    const bounded = { ...policy, maxTokens: novaOutputLimit(policy.maxTokens) };
    let inputTokens: number;
    try {
      // Nova Pro v1 does not support CountTokens. Reserve its ENTIRE published
      // context window, never a character/token estimate. Larger requests cannot
      // be accepted by this version; successful calls settle their actual usage.
      // https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-pro.html
      if (novaModelForTier(policy.tier) !== "us.amazon.nova-pro-v1:0") throw new Error("unverified_model_bound");
      inputTokens = 300_000;
    }
    catch { throw new PaidAIBudgetError("model_input_bound_unverified"); }
    const reserved = await this.budget.reservePaidAttempt({ providerId: this.providerId,
      modelId: novaModelForTier(policy.tier), inputTokens, maxOutputTokens: bounded.maxTokens });
    if (!reserved.allowed) throw new PaidAIBudgetError(reserved.reason);
    // Any exception/timeout/unknown usage retains the full reservation. Never refund blindly.
    const result = await execute(bounded);
    if (result.modelId !== reserved.reservation.pricing.modelId) throw new PaidAIBudgetError("model_identity_mismatch");
    await this.budget.settlePaidAttempt(reserved.reservation, result.usage);
    return result;
  }
  generateText(task: AITask, system: string, user: string, policy: AIGeneratePolicy) {
    return this.run(system, user, policy, undefined, p => this.inner.generateText(task, system, user, p));
  }
  generateStructured<T>(task: AITask, system: string, user: string, tool: AIToolSchema, policy: AIGeneratePolicy) {
    return this.run(system, user, policy, tool, p => this.inner.generateStructured<T>(task, system, user, tool, p));
  }
}
