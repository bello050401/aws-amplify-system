import type { AIGatewayProvider, AIGeneratePolicy, AIGenerateResult, AITask, AITokenUsage, AIToolSchema } from "./types";
import { checkTextQuality, checkStructuredQuality, type TextQualityRules, type QualityGateResult } from "./qualityGate";

/**
 * §4/§4.1: AIRouter — 品質ゲート不合格の場合だけPREMIUMへescalationする。
 * 「無条件二重生成は禁止」(§5)を守るため、ECONOMY/STANDARDの結果が
 * 品質ゲートを通れば、それ以上何もしない(PREMIUMへは絶対に進まない)。
 * 純粋なオーケストレーションのみ — 実際の生成はprovider(Anthropic等)、
 * 判定はqualityGate.tsの純粋関数に委譲する。
 */

export interface RouterTextRequest {
  task: AITask;
  systemPrompt: string;
  userPrompt: string;
  policy: Omit<AIGeneratePolicy, "tier"> & { initialTier: Exclude<AIGeneratePolicy["tier"], "PREMIUM"> | "PREMIUM" };
  qualityRules?: TextQualityRules;
}

/**
 * §4.1: initialTierで生成→品質ゲート判定→不合格ならPREMIUMで1回だけ
 * 再生成(既にPREMIUMを指定していた場合はescalationしようがないので
 * そのまま返す)。
 */
export async function routeGenerateText(provider: AIGatewayProvider, req: RouterTextRequest): Promise<AIGenerateResult<string>> {
  const first = await provider.generateText(req.task, req.systemPrompt, req.userPrompt, { ...req.policy, tier: req.policy.initialTier });
  const gate = checkTextQuality(first.output, req.qualityRules);

  if (gate.pass || req.policy.initialTier === "PREMIUM") {
    return { ...first, qualityGatePassed: gate.pass, qualityGateViolations: gate.violations };
  }

  // §4.1 escalation: 1回だけPREMIUMへ。
  const escalated = await provider.generateText(req.task, req.systemPrompt, req.userPrompt, { ...req.policy, tier: "PREMIUM" });
  const escalatedGate = checkTextQuality(escalated.output, req.qualityRules);
  return { ...escalated, fallbackOccurred: true, qualityGatePassed: escalatedGate.pass, qualityGateViolations: escalatedGate.violations };
}

export interface RouterStructuredRequest<T extends Record<string, unknown>> {
  task: AITask;
  systemPrompt: string;
  userPrompt: string;
  toolSchema: AIToolSchema;
  policy: Omit<AIGeneratePolicy, "tier"> & { initialTier: AIGeneratePolicy["tier"] };
  requiredNonEmptyFields: (keyof T)[];
}

export async function routeGenerateStructured<T extends Record<string, unknown>>(
  provider: AIGatewayProvider,
  req: RouterStructuredRequest<T>,
): Promise<AIGenerateResult<T>> {
  const first = await provider.generateStructured<T>(req.task, req.systemPrompt, req.userPrompt, req.toolSchema, { ...req.policy, tier: req.policy.initialTier });
  const gate = checkStructuredQuality(first.output, req.requiredNonEmptyFields);

  if (gate.pass || req.policy.initialTier === "PREMIUM") {
    return { ...first, qualityGatePassed: gate.pass, qualityGateViolations: gate.violations };
  }

  const escalated = await provider.generateStructured<T>(req.task, req.systemPrompt, req.userPrompt, req.toolSchema, { ...req.policy, tier: "PREMIUM" });
  const escalatedGate = checkStructuredQuality(escalated.output, req.requiredNonEmptyFields);
  return { ...escalated, fallbackOccurred: true, qualityGatePassed: escalatedGate.pass, qualityGateViolations: escalatedGate.violations };
}

export type { QualityGateResult, AITokenUsage };
