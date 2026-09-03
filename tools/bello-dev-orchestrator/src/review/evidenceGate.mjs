/**
 * 証拠ゲート (指示書 §7-4 幻覚・暴走対策)。
 *
 * AI の「合格」という文章を最終判断にしない。ここは AI を一切使わず、
 * 完了報告と実際の Git / テスト結果を機械的に突合する。
 * AI 審査が accept と言っても、このゲートが落ちれば accept にしない。
 */
import fs from "node:fs";
import path from "node:path";

/**
 * @returns {{passed: boolean, failures: string[], warnings: string[], checks: Array}}
 */
export function evaluateEvidence({ report, gitFacts, repoPath }) {
  const failures = [];
  const warnings = [];
  const checks = [];

  const record = (criterion, result, evidence) => {
    checks.push({ criterion, result, evidence });
    if (result === "failed") failures.push(`${criterion}: ${evidence}`);
    if (result === "unknown") warnings.push(`${criterion}: ${evidence}`);
  };

  // 1. status と本文の整合
  if (report?.status !== "completed") {
    record("status が completed である", "failed", `status=${report?.status}`);
  } else {
    record("status が completed である", "passed", "status=completed");
  }

  // 2. テスト結果。failed が 1 件でもあれば不合格。
  const tests = Array.isArray(report?.tests) ? report.tests : [];
  const failed = tests.filter((t) => t.result === "failed");
  const passed = tests.filter((t) => t.result === "passed");
  if (tests.length === 0) {
    record("テストが実行されている", "failed", "tests が空です。テスト未実行を完了と呼ばない (§1-3)。");
  } else if (failed.length > 0) {
    record("テストがすべて成功している", "failed", `失敗 ${failed.length} 件: ${failed.map((t) => t.name).join(", ")}`);
  } else if (passed.length === 0) {
    record("テストがすべて成功している", "failed", "passed が 0 件です (skipped のみ)。");
  } else {
    record("テストがすべて成功している", "passed", `passed ${passed.length} / total ${tests.length}`);
  }

  // 3. 実行コマンドの exit code
  const commands = Array.isArray(report?.commandsRun) ? report.commandsRun : [];
  const badExit = commands.filter((c) => Number.isInteger(c.exitCode) && c.exitCode !== 0);
  if (badExit.length > 0) {
    record(
      "実行コマンドがすべて成功している",
      "failed",
      `非 0 終了: ${badExit.map((c) => `${c.commandRedacted}(=${c.exitCode})`).join(", ")}`,
    );
  } else if (commands.length === 0) {
    record("実行コマンドがすべて成功している", "unknown", "commandsRun が空です。");
  } else {
    record("実行コマンドがすべて成功している", "passed", `${commands.length} 件すべて exit 0`);
  }

  // 4. 変更が実在するか。報告された path が本当にリポジトリにあるか確かめる。
  const changes = Array.isArray(report?.changes) ? report.changes : [];
  if (changes.length === 0) {
    record("変更内容が報告されている", "unknown", "changes が空です (調査のみのタスクなら正常)。");
  } else if (repoPath) {
    const missing = [];
    for (const change of changes) {
      const rel = String(change.path ?? "");
      if (!rel) continue;
      // パストラバーサル対策: リポジトリ外を指す報告は検査対象にしない
      const abs = path.resolve(repoPath, rel);
      if (!abs.startsWith(path.resolve(repoPath))) {
        warnings.push(`報告された変更パスがリポジトリ外です: ${rel}`);
        continue;
      }
      // 削除されたファイルもあり得るので、存在しないことを即失敗にはしない
      if (!fs.existsSync(abs)) missing.push(rel);
    }
    if (missing.length === changes.length && changes.length > 0) {
      record(
        "報告された変更ファイルが実在する",
        "failed",
        `報告された ${changes.length} 件がいずれも存在しません: ${missing.slice(0, 5).join(", ")}`,
      );
    } else {
      record(
        "報告された変更ファイルが実在する",
        "passed",
        missing.length ? `${changes.length - missing.length}/${changes.length} 件を確認 (削除分を含む可能性)` : `${changes.length} 件を確認`,
      );
    }
  }

  // 5. Git の実測との突合
  if (gitFacts) {
    if (report?.git?.commitCreated === true) {
      if (gitFacts.headCommit && gitFacts.startCommit && gitFacts.headCommit === gitFacts.startCommit) {
        record(
          "コミット作成の報告が Git と一致する",
          "failed",
          `commitCreated=true だが HEAD が変わっていません (${gitFacts.startCommit.slice(0, 8)})`,
        );
      } else {
        record("コミット作成の報告が Git と一致する", "passed", `HEAD ${String(gitFacts.headCommit).slice(0, 8)}`);
      }
    }
    if (gitFacts.protectedBranchTouched) {
      record("保護ブランチを操作していない", "failed", `保護ブランチ ${gitFacts.branch} 上で自動コミットしています`);
    }
  }

  // 6. 危険フラグ
  const risks = Array.isArray(report?.riskFlags) ? report.riskFlags : [];
  if (risks.length > 0) warnings.push(`riskFlags: ${risks.join(", ")}`);

  return { passed: failures.length === 0, failures, warnings, checks };
}
