/**
 * 日付のみ(タイムゾーンなし)を扱うユーティリティ。
 *
 * 取引年月日・棚卸日は "YYYY-MM-DD" 文字列として保存し、Dateオブジェクトの
 * タイムゾーン変換を経由しないことで、日本時間前提の日付がUTC変換でずれる
 * 問題を避ける (指示書 §12)。
 */

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateOnly(value: string): boolean {
  if (!DATE_ONLY_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/** "YYYY-MM-DD" -> "YYYY/MM/DD" 表示用フォーマット (指示書 §12) */
export function formatDateOnlyForDisplay(value?: string | null): string {
  if (!value || !isValidDateOnly(value)) return "-";
  return value.replaceAll("-", "/");
}

/** 今日の日付(JST)を "YYYY-MM-DD" で返す */
export function todayDateOnlyJST(): string {
  const now = new Date();
  // JST = UTC+9。ローカル実行環境のタイムゾーンに依存せずJSTの「その日」を求める。
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function formatDateTimeJST(iso: string): string {
  try {
    return new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
