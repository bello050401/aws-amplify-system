/**
 * scripts/verify-ai-gateway-recording.ts 専用fixture。
 *
 * lib/ai/gateway/gateway.ts が相対importする
 * ./anthropicProvider / ./bedrockProvider / ./novaProvider を丸ごと
 * 差し替える(いずれも外部SDK(@anthropic-ai/sdk等)へ依存しており、
 * このworktreeにはnode_modulesが無いため実SDKは読み込めない)。
 *
 * 3つのクラス名(AnthropicGatewayProvider/BedrockGatewayProvider/
 * NovaGatewayProvider)はどれも同じ挙動を返す —— gateway.tsの
 * resolveProviderId()がどれを選んでも、テスト側は__configureで
 * 設定したsteps/modelIdをそのまま消費する共有state。
 */

let steps = [];
let modelIdByCallIndex = [];
let call = 0;

/** 各呼び出し(初回・escalation)ごとの応答を順に設定する。 */
export function __configure(newSteps, newModelIdByCallIndex = []) {
  steps = newSteps;
  modelIdByCallIndex = newModelIdByCallIndex;
  call = 0;
}

export function __callCount() {
  return call;
}

async function generateText() {
  const step = steps[Math.min(call, steps.length - 1)];
  const modelId = modelIdByCallIndex[call] ?? "fake-model";
  call++;
  if (step.error) throw new Error(step.error);
  return {
    output: step.output,
    usage: { inputTokens: 10 * call, outputTokens: 5 * call },
    latencyMs: 1,
    providerId: "fake",
    modelId,
    qualityTier: "STANDARD",
    fallbackOccurred: false,
    // 本物のprovider実装(anthropicProvider.ts等)と同じく、providerは
    // 品質ゲートを知らずtrue固定で返す。
    qualityGatePassed: true,
    qualityGateViolations: [],
  };
}

async function generateStructured() {
  const step = steps[Math.min(call, steps.length - 1)];
  const modelId = modelIdByCallIndex[call] ?? "fake-model";
  call++;
  if (step.error) throw new Error(step.error);
  return {
    output: JSON.parse(step.output),
    usage: { inputTokens: 10 * call, outputTokens: 5 * call },
    latencyMs: 1,
    providerId: "fake",
    modelId,
    qualityTier: "STANDARD",
    fallbackOccurred: false,
    qualityGatePassed: true,
    qualityGateViolations: [],
  };
}

async function healthCheck() {
  return { ok: true, message: "fake" };
}

function estimateCost(modelId, usage) {
  const perMillion = {
    "economy-model": { in: 1, out: 2 },
    "premium-model": { in: 10, out: 20 },
  };
  const price = perMillion[modelId];
  if (!price) return null;
  return (usage.inputTokens / 1_000_000) * price.in + (usage.outputTokens / 1_000_000) * price.out;
}

class FakeGatewayProvider {
  providerId = "fake";
  generateText = generateText;
  generateStructured = generateStructured;
  healthCheck = healthCheck;
  estimateCost = estimateCost;
}

export class AnthropicGatewayProvider extends FakeGatewayProvider {}
export class BedrockGatewayProvider extends FakeGatewayProvider {}
export class NovaGatewayProvider extends FakeGatewayProvider {}
