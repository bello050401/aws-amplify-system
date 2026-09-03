/**
 * Fake Claude Runner (指示書 §14-2)。
 *
 * 実 Claude を呼ばずに全状態遷移を自動検証するために使う。
 * 本番コードから参照されるのはテストと `--fake` 診断実行のときだけ。
 */
import { TERMINATION } from "./claudeRunner.mjs";

/** 最低限スキーマを満たす完了報告を作る。 */
export function makeReport(taskId, overrides = {}) {
  return {
    taskId,
    status: "completed",
    summary: "fake runner による疑似実行",
    investigation: ["既存実装を調査した (fake)"],
    decisions: [],
    changes: [{ path: "fake/file.ts", purpose: "疑似変更" }],
    commandsRun: [{ commandRedacted: "npm test", exitCode: 0, purpose: "テスト" }],
    tests: [{ name: "unit", result: "passed", evidencePath: "" }],
    git: { branch: "fake-branch", startCommit: "aaa", endCommit: "bbb", commitCreated: true, workingTreeSummary: "clean" },
    remainingIssues: [],
    userActions: [],
    recommendedNextActions: [],
    riskFlags: [],
    evidencePaths: [],
    ...overrides,
  };
}

/**
 * scripts: タスク ID もしくは実行回数に応じた振る舞いを定義する配列。
 * 例: [{ report: {...} }, { crash: true }]
 */
export class FakeClaudeRunner {
  constructor(script = []) {
    this.script = Array.isArray(script) ? [...script] : [];
    this.calls = [];
    this.defaultBehaviour = { kind: "success" };
  }

  setDefault(behaviour) {
    this.defaultBehaviour = behaviour;
  }

  async run({ task, instruction, resumeSessionId = null, onHeartbeat = () => {} }) {
    this.calls.push({ taskId: task.id, instruction, resumeSessionId, at: new Date().toISOString() });
    onHeartbeat();

    const behaviour = this.script.shift() ?? this.defaultBehaviour;

    // 実行中に副作用 (ファイル変更・コミット等) を起こしたいテスト用。
    // 実 Claude と同じく「run の最中にリポジトリが変わる」状況を再現する。
    if (typeof behaviour.effect === "function") await behaviour.effect({ task });

    if (behaviour.kind === "crash") {
      return {
        ok: false,
        terminationReason: TERMINATION.CRASHED,
        exitCode: behaviour.exitCode ?? 1,
        durationMs: 10,
        report: null,
        reportErrors: [],
        stderrTail: behaviour.stderr ?? "fake crash",
        sessionId: null,
        error: behaviour.error ?? "fake crash",
      };
    }
    if (behaviour.kind === "timeout") {
      return {
        ok: false,
        terminationReason: TERMINATION.TIMEOUT,
        exitCode: null,
        durationMs: 10,
        report: null,
        reportErrors: [],
        sessionId: null,
        error: "fake timeout",
      };
    }
    if (behaviour.kind === "invalid_report") {
      return {
        ok: false,
        terminationReason: TERMINATION.COMPLETED,
        exitCode: 0,
        durationMs: 10,
        report: { taskId: task.id, status: "nonsense" },
        reportErrors: ["$.status: 許可された値ではありません"],
        sessionId: "fake-session",
      };
    }

    const report = behaviour.report ?? makeReport(task.id, behaviour.overrides ?? {});
    return {
      ok: report.status === "completed" || report.status === "partial",
      terminationReason: TERMINATION.COMPLETED,
      exitCode: 0,
      durationMs: 10,
      report,
      reportErrors: [],
      sessionId: behaviour.sessionId ?? "fake-session",
      costUsd: 0,
      numTurns: 1,
      permissionDenials: [],
    };
  }
}
