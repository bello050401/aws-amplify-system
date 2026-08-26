import { AnthropicProvider } from "./anthropic";
import { OpenAIProvider } from "./openai";
import type { AIProvider } from "./types";

export * from "./types";
export { suggestTemplateType, suggestSlug } from "./templateHeuristic";

let instance: AIProvider | null = null;

/** Single entry point — swap providers with `AI_PROVIDER=anthropic|openai`, no caller changes. */
export function getAIProvider(): AIProvider {
  if (!instance) {
    const provider = process.env.AI_PROVIDER ?? "anthropic";
    instance = provider === "openai" ? new OpenAIProvider() : new AnthropicProvider();
  }
  return instance;
}
