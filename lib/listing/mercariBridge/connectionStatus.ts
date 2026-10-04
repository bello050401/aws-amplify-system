import type { ReadResultView } from "./resultView";

export type MercariPcConnectionStatus = {
  pc: "NO_REPORT" | "REPORT_RECEIVED";
  shops: "LOGIN_UNCONFIRMED" | "READ_CONFIRMED" | "REAUTH_REQUIRED";
  recordedAt: string | null;
};

/** Reports prove a past PC exchange, never a live socket or listing permission. */
export function mercariPcConnectionStatus(results: ReadResultView[]): MercariPcConnectionStatus {
  const latest = [...results].filter(result => Number.isFinite(Date.parse(result.recordedAt)))
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0];
  if (!latest) return { pc: "NO_REPORT", shops: "LOGIN_UNCONFIRMED", recordedAt: null };
  const observedProduct = latest.identity === "MATCH" &&
    (["PRIVATE_OBSERVED", "NOT_PRIVATE"].includes(latest.visibility ?? "") ||
      Object.values(latest.fields).some(value => value === "MATCH" || value === "DIFFERENT"));
  const shops = latest.status === "AUTH_REQUIRED" ? "REAUTH_REQUIRED" :
    observedProduct &&
    ["NOT_PRIVATE", "DIFFERENT", "INCOMPLETE", "CORE_FIELDS_MATCH"].includes(latest.status) ?
      "READ_CONFIRMED" : "LOGIN_UNCONFIRMED";
  return { pc: "REPORT_RECEIVED", shops, recordedAt: latest.recordedAt };
}
