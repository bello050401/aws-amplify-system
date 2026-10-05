import type { ReadResultView } from "./resultView";

export type MercariPcConnectionStatus = {
  pc: "NO_REPORT" | "REPORT_RECEIVED";
  shops: "LOGIN_UNCONFIRMED" | "READ_CONFIRMED" | "REAUTH_REQUIRED";
  recordedAt: string | null;
};

export type ConnectionLookupState = "UNFETCHED" | "LOADING" | "FAILED" | "READY";

/** A delayed proof report has a BELLO receipt time, not the original HTTP observation time. */
export function mercariDirectReadProofReportedAt(results: ReadResultView[]): string | null {
  return results.filter(result => result.status === "DIRECT_HTTP_READ_CONFIRMED" &&
      result.reasonCode === "PINNED_HTTP_200_MATCHED" &&
      Number.isFinite(Date.parse(result.recordedAt)))
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0]?.recordedAt ?? null;
}

export function mercariPcConnectionLabels(lookup: ConnectionLookupState,
  results: ReadResultView[]): { pc: string; shops: string; recordedAt: string | null } {
  if (lookup !== "READY") {
    const label = lookup === "LOADING" ? "確認中" : lookup === "FAILED" ?
      "取得失敗" : "未確認（記録未取得）";
    return { pc: label, shops: label, recordedAt: null };
  }
  const state = mercariPcConnectionStatus(results);
  return { pc: state.pc === "REPORT_RECEIVED" ? "報告受信済み" :
      "未接続（この依頼の報告なし）",
    shops: state.shops === "REAUTH_REQUIRED" ? "再認証必要" :
      state.shops === "READ_CONFIRMED" ? "読取確認済み" : "ログイン未確認",
    recordedAt: state.recordedAt };
}

/** Reports prove a past PC exchange, never a live socket or listing permission. */
export function mercariPcConnectionStatus(results: ReadResultView[]): MercariPcConnectionStatus {
  const reported = [...results].filter(result => Number.isFinite(Date.parse(result.recordedAt)))
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0];
  if (!reported) return { pc: "NO_REPORT", shops: "LOGIN_UNCONFIRMED", recordedAt: null };
  // A past HTTP proof can arrive after a newer authentication failure. It is
  // displayed separately and cannot restore the current Shops login label.
  const latest = [...results].filter(result => result.status !== "DIRECT_HTTP_READ_CONFIRMED" &&
      Number.isFinite(Date.parse(result.recordedAt)))
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0];
  if (!latest) return { pc: "REPORT_RECEIVED", shops: "LOGIN_UNCONFIRMED",
    recordedAt: reported.recordedAt };
  const observedProduct = latest.identity === "MATCH" &&
    (["PRIVATE_OBSERVED", "NOT_PRIVATE"].includes(latest.visibility ?? "") ||
      Object.values(latest.fields).some(value => value === "MATCH" || value === "DIFFERENT"));
  const shops = latest.status === "AUTH_REQUIRED" ? "REAUTH_REQUIRED" :
    observedProduct &&
    ["NOT_PRIVATE", "DIFFERENT", "INCOMPLETE", "CORE_FIELDS_MATCH"].includes(latest.status) ?
      "READ_CONFIRMED" : "LOGIN_UNCONFIRMED";
  return { pc: "REPORT_RECEIVED", shops, recordedAt: reported.recordedAt };
}
