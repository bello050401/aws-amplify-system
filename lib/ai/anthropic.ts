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

export class AnthropicProvider implements AIProvider {
  async generateFeatureCopy(input: FeatureGenerationInput): Promise<FeatureCopy> {
    const res = await client().messages.create({
      model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
      max_tokens: 2000,
      system: buildSystemPrompt(),
      messages: [{ role: "user", content: buildUserPrompt(input) }],
      tools: [FEATURE_COPY_TOOL],
      tool_choice: { type: "tool", name: FEATURE_COPY_TOOL.name },
    });

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
    const res = await client().messages.create({
      model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
      max_tokens: 500,
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

    const textBlock = res.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("AI response did not include text output.");
    }
    return textBlock.text.trim();
  }
}
