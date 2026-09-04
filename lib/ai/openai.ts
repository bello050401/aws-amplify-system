import "server-only";
import { suggestSlug } from "./templateHeuristic";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";
import type { AIProvider, FeatureCopy, FeatureCopySection, FeatureGenerationInput } from "./types";
import { fetchWithTimeout } from "@/lib/http/fetchWithTimeout";

/**
 * この経路の外部呼び出し。応答が返らないまま固まらないよう上限を持つ
 * （2026-09-04 健全化 PHASE 8 — lib/http/fetchWithTimeout.ts）。
 * どこが時間切れになったのかがログで分かるよう、名前を付けて渡す。
 */
const fetchExternal = (input: string | URL | Request, init?: RequestInit) =>
  fetchWithTimeout(input, init, { label: "OpenAI API" });


/**
 * Secondary provider (spec §18: "OpenAI API等も利用できるよう抽象化").
 * Uses plain `fetch` against the Chat Completions API with JSON mode
 * rather than the SDK, to avoid adding a dependency that most deployments
 * of this system (Anthropic-first) won't use.
 */
async function chat(messages: { role: string; content: string }[], jsonMode: boolean) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. ローカル開発では .env に設定してください(README参照)。本番(Amplify Hosting)では環境変数として設定します。",
    );
  }

  const res = await fetchExternal("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? "gpt-4o",
      messages,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
  });

  if (!res.ok) throw new Error(`OpenAI API error: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return body.choices[0].message.content as string;
}

export class OpenAIProvider implements AIProvider {
  async generateFeatureCopy(input: FeatureGenerationInput): Promise<FeatureCopy> {
    const content = await chat(
      [
        { role: "system", content: buildSystemPrompt() },
        {
          role: "user",
          content: `${buildUserPrompt(input)}\n\n必ず有効なJSONオブジェクトとして、指定した項目のキーで返してください。`,
        },
      ],
      true,
    );

    const parsed = JSON.parse(content) as Omit<FeatureCopy, "slug"> & { slug?: string };
    return { ...parsed, slug: parsed.slug || suggestSlug(parsed.title, input.items) };
  }

  async regenerateSection(
    input: FeatureGenerationInput,
    section: FeatureCopySection,
    current: FeatureCopy,
  ): Promise<string> {
    const content = await chat(
      [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildUserPrompt(input) },
        { role: "assistant", content: `これまでの生成結果: ${JSON.stringify(current)}` },
        {
          role: "user",
          content: `"${section}" の項目だけ書き直してください。新しいテキストのみをプレーンテキストで返してください。`,
        },
      ],
      false,
    );
    return content.trim();
  }
}
