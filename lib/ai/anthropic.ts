import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { suggestSlug } from "./templateHeuristic";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";
import type { AIProvider, FeatureCopy, FeatureCopySection, FeatureGenerationInput } from "./types";

const FEATURE_COPY_TOOL = {
  name: "emit_feature_copy",
  description: "Structured feature-page copy grounded strictly in the provided item data.",
  input_schema: {
    type: "object" as const,
    properties: {
      title: { type: "string" },
      slug: { type: "string" },
      headline: { type: "string" },
      intro: { type: "string" },
      productGroupNotes: { type: "string" },
      differenceNotes: { type: "string" },
      colorVariationNotes: { type: "string" },
      stylingSuggestion: { type: "string" },
      ctaText: { type: "string" },
      seoTitle: { type: "string" },
      seoDescription: { type: "string" },
    },
    required: [
      "title",
      "slug",
      "headline",
      "intro",
      "productGroupNotes",
      "differenceNotes",
      "stylingSuggestion",
      "ctaText",
      "seoTitle",
      "seoDescription",
    ],
  },
};

function client() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. ローカル開発では .env に設定してください(README参照)。本番(Amplify Hosting)では環境変数として設定します。",
    );
  }
  return new Anthropic({ apiKey });
}

/**
 * Claude Sonnet 5 (unlike Sonnet 4.6 and older) runs adaptive extended
 * thinking by default the moment `thinking` is omitted — thinking tokens
 * then count against `max_tokens` alongside the actual output, so a
 * `max_tokens` sized for "just the JSON/text" can truncate mid-response
 * on models that predate this default. We don't need deep reasoning for
 * marketing copy, so we set `thinking` explicitly (rather than relying on
 * whatever a given model's default happens to be) and keep `output_config.
 * effort` low ("medium" for the full generation, "low" for a one-field
 * rewrite) — cheaper and, per Anthropic's current guidance, safer than
 * disabling thinking outright while forcing a specific tool (a
 * disabled-thinking model can occasionally emit the tool call as plain
 * text instead of a real tool_use block). `max_tokens` below has headroom
 * for that thinking spend on top of the actual copy/JSON output.
 */
const THINKING = { type: "adaptive" } as const;

/**
 * Prompt caching (`cache_control: { type: "ephemeral" }`) is deliberately
 * NOT used here. It only pays off when the same prefix (system prompt +
 * tools) is resent across many requests — e.g. one long chat session, or
 * a fixed prefix reused hundreds of times. Every call here has a unique
 * user prompt (a different, freshly-selected set of BASE items each time)
 * immediately after a short, sub-1K-token system prompt/tool schema, so
 * there's no repeated prefix to cache, and Anthropic's minimum cacheable
 * prefix (roughly 1024–4096 tokens depending on model) is unlikely to be
 * met by the system+tools portion alone anyway — a cache_control block
 * here would just add write overhead for cache reads that never happen.
 * Revisit this if a single system prompt/tool set ends up reused across a
 * high volume of generations (see docs/NOTES_BASE_API.md).
 */
function describeAnthropicError(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    // `err.message` from the SDK is already "<status> <API's own JSON
    // error message>" (e.g. "400 {\"type\":\"invalid_request_error\",...}"),
    // which is exactly what shows up in the admin UI today — this just
    // adds the request id (useful when asking Anthropic support about a
    // specific failure) without ever touching the API key.
    const requestId = err.requestID ? ` (request_id: ${err.requestID})` : "";
    return `Anthropic API error: ${err.message}${requestId}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export class AnthropicProvider implements AIProvider {
  async generateFeatureCopy(input: FeatureGenerationInput): Promise<FeatureCopy> {
    let res;
    try {
      res = await client().messages.create({
        model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
        max_tokens: 4000,
        thinking: THINKING,
        output_config: { effort: "medium" },
        system: buildSystemPrompt(),
        messages: [{ role: "user", content: buildUserPrompt(input) }],
        tools: [FEATURE_COPY_TOOL],
        tool_choice: { type: "tool", name: FEATURE_COPY_TOOL.name },
      });
    } catch (err) {
      console.error("[Anthropic generateFeatureCopy] request failed:", err);
      throw new Error(describeAnthropicError(err));
    }

    const toolUse = res.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("AI response did not include the expected structured output.");
    }

    const parsed = toolUse.input as Omit<FeatureCopy, "slug"> & { slug?: string };
    return {
      ...parsed,
      slug: parsed.slug || suggestSlug(parsed.title, input.items),
    };
  }

  async regenerateSection(
    input: FeatureGenerationInput,
    section: FeatureCopySection,
    current: FeatureCopy,
  ): Promise<string> {
    let res;
    try {
      res = await client().messages.create({
        model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
        max_tokens: 1500,
        thinking: THINKING,
        output_config: { effort: "low" },
        system: buildSystemPrompt(),
        messages: [
          { role: "user", content: buildUserPrompt(input) },
          {
            role: "assistant",
            content: `これまでの生成結果: ${JSON.stringify(current)}`,
          },
          {
            role: "user",
            content: `"${section}" の項目だけ書き直してください。他の項目には触れず、"${section}" の新しいテキストだけをプレーンテキストで返してください。`,
          },
        ],
      });
    } catch (err) {
      console.error("[Anthropic regenerateSection] request failed:", err);
      throw new Error(describeAnthropicError(err));
    }

    const textBlock = res.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("AI response did not include text output.");
    }
    return textBlock.text.trim();
  }
}
