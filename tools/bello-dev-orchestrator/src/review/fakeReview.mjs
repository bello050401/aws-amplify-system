/**
 * Fake Review Engine (指示書 §14-2, §18-3)。
 * OpenAI へ課金せずに全状態遷移を自動検証するために使う。
 */
import { ReviewUnavailableError } from "./openaiReview.mjs";
import { REVIEW_PROMPT_VERSION } from "./reviewSchema.mjs";

export function makeReview(decision, overrides = {}) {
  return {
    decision,
    reason: `fake review: ${decision}`,
    acceptanceCriteriaResults: [{ criterion: "fake", result: "passed", evidence: "fake" }],
    nextClaudeInstruction: decision === "revision_required" ? "テストを追加して再検証してください。" : null,
    userTodos: [],
    riskFlags: [],
    shouldRunNextQueuedTask: decision === "accept_and_continue",
    confidence: 0.9,
    ...overrides,
  };
}

export class FakeReviewEngine {
  /**
   * @param {Array<{kind:'review'|'unavailable', review?:object, reason?:string}>} script
   */
  constructor(script = []) {
    this.script = Array.isArray(script) ? [...script] : [];
    this.calls = [];
    this.defaultBehaviour = { kind: "review", review: makeReview("accept_and_continue") };
    this.configured = true;
    this.provider = "fake";
  }

  isConfigured() {
    return this.configured;
  }

  setDefault(behaviour) {
    this.defaultBehaviour = behaviour;
  }

  async review({ task, report }) {
    this.calls.push({ taskId: task.id, status: report?.status, at: new Date().toISOString() });
    const behaviour = this.script.shift() ?? this.defaultBehaviour;

    if (behaviour.kind === "unavailable") {
      throw new ReviewUnavailableError(behaviour.message ?? "fake unavailable", behaviour.reason ?? "api_failure");
    }
    return {
      review: behaviour.review ?? makeReview("accept_and_continue"),
      meta: { model: "fake-model", promptVersion: REVIEW_PROMPT_VERSION, usage: null, provider: "fake", attempts: 1 },
    };
  }
}
