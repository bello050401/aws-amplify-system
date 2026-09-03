/**
 * OpenAI Review Engine (指示書 §7)。
 *
 * 既存 lib/ai/openai.ts と同じ規約 (fetch / OPENAI_API_KEY / OPENAI_MODEL) を使う。
 * SDK を足さない理由は docs/ADR-0001 §5 を参照。
 */
import { REVIEW_SCHEMA, REVIEW_SYSTEM_PROMPT, REVIEW_PROMPT_VERSION, buildReviewInput } from "./reviewSchema.mjs";
import { validate } from "../core/validate.mjs";
import { redactValue, redactText } from "../log/redact.mjs";

const API_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-2024-08-06"; // strict structured outputs に対応する版

export class ReviewUnavailableError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = "ReviewUnavailableError";
    this.reason = reason; // 'no_api_key' | 'api_failure'
  }
}

/**
 * OpenAI の JSON Schema (strict) は additionalProperties:false と
 * required に全プロパティを要求する。REVIEW_SCHEMA はその条件を満たしている。
 */
function toOpenAiResponseFormat() {
  return {
    type: "json_schema",
    json_schema: { name: "bello_review", strict: true, schema: REVIEW_SCHEMA },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class OpenAiReviewEngine {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.provider = "openai";
  }

  get apiKey() {
    return process.env.OPENAI_API_KEY || "";
  }

  get model() {
    return this.config.review.model || process.env.OPENAI_MODEL || DEFAULT_MODEL;
  }

  isConfigured() {
    return this.apiKey.length > 0;
  }

  /**
   * 審査を実行する。API キーが無い場合は ReviewUnavailableError('no_api_key')。
   * 呼び出し側はそれを掴んで awaiting_ai_review + ユーザー TODO にする (§7-1)。
   */
  async review({ task, report, gitStat, testSummary, priorReviews }) {
    if (!this.isConfigured()) {
      throw new ReviewUnavailableError(
        "OPENAI_API_KEY が設定されていないため AI 審査を実行できません。",
        "no_api_key",
      );
    }

    const input = buildReviewInput({
      task,
      report,
      gitStat,
      testSummary,
      priorReviews,
      maxDiffChars: this.config.review.maxDiffChars,
    });
    // 送信前に必ず秘密を落とす (§7-2)
    const safeInput = redactValue(input);

    const body = {
      model: this.model,
      messages: [
        { role: "system", content: REVIEW_SYSTEM_PROMPT },
        {
          role: "user",
          content:
            "次の開発タスクと Claude Code の完了報告を審査し、指定 JSON スキーマで返してください。\n\n" +
            JSON.stringify(safeInput, null, 2),
        },
      ],
      response_format: toOpenAiResponseFormat(),
      temperature: 0,
    };

    const maxRetries = this.config.review.maxRetries;
    let attempt = 0;
    let lastError = null;

    while (attempt <= maxRetries) {
      attempt += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.review.requestTimeoutSeconds * 1000);
      try {
        const res = await fetch(API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (res.status === 429 || res.status >= 500) {
          lastError = new Error(`OpenAI API 一時エラー: ${res.status}`);
          await this.#backoff(attempt);
          continue;
        }
        if (!res.ok) {
          const text = await res.text();
          throw new ReviewUnavailableError(
            `OpenAI API エラー ${res.status}: ${redactText(text).slice(0, 500)}`,
            "api_failure",
          );
        }

        const payload = await res.json();
        const content = payload?.choices?.[0]?.message?.content;
        const refusal = payload?.choices?.[0]?.message?.refusal;
        if (refusal) {
          throw new ReviewUnavailableError(`審査モデルが応答を拒否しました: ${redactText(refusal)}`, "api_failure");
        }
        if (typeof content !== "string") {
          lastError = new Error("OpenAI の応答に content がありません。");
          await this.#backoff(attempt);
          continue;
        }

        let parsed;
        try {
          parsed = JSON.parse(content);
        } catch (err) {
          lastError = new Error(`審査結果を JSON として解釈できません: ${err.message}`);
          await this.#backoff(attempt);
          continue;
        }

        const check = validate(parsed, REVIEW_SCHEMA);
        if (!check.valid) {
          lastError = new Error(`審査結果がスキーマに適合しません: ${check.errors.join(" / ")}`);
          // スキーマ違反は 1 度だけ自己修正を求める (§6-5 と同じ方針)
          if (attempt <= 1) {
            body.messages.push({ role: "assistant", content });
            body.messages.push({
              role: "user",
              content: `前回の出力はスキーマ違反です: ${check.errors.join(" / ")}\nスキーマに厳密に従って出し直してください。`,
            });
            continue;
          }
          throw new ReviewUnavailableError(lastError.message, "api_failure");
        }

        return {
          review: parsed,
          meta: {
            model: payload?.model ?? this.model,
            promptVersion: REVIEW_PROMPT_VERSION,
            usage: payload?.usage ?? null,
            provider: this.provider,
            attempts: attempt,
          },
        };
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof ReviewUnavailableError) throw err;
        lastError = err;
        if (attempt > maxRetries) break;
        await this.#backoff(attempt);
      }
    }

    throw new ReviewUnavailableError(
      `OpenAI 審査が ${maxRetries + 1} 回失敗しました: ${lastError ? redactText(lastError.message) : "不明"}`,
      "api_failure",
    );
  }

  async #backoff(attempt) {
    const base = this.config.review.baseBackoffSeconds;
    const max = this.config.review.maxBackoffSeconds;
    const seconds = Math.min(base * 2 ** (attempt - 1), max);
    this.logger?.warn?.("OpenAI 審査を再試行します", { attempt, waitSeconds: seconds });
    await sleep(seconds * 1000);
  }
}
