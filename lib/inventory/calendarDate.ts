/** Date-only business values from ZAICO/CSV/Excel. Do not shift through UTC:
 * historic exports include a time suffix although the field represents a date.
 * Accept only an explicit calendar date and a valid optional time, never guess
 * ambiguous month/day order or Excel serial values in a text column.
 */
export function normalizeCalendarDate(raw: string): string | null {
  const text = raw.trim().replace(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/, "$1-$2-$3");
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(text);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  if (hour !== undefined && (+hour > 23 || +minute > 59 || +(second ?? 0) > 59)) return null;
  const normalized = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const date = new Date(`${normalized}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() === +year && date.getUTCMonth() + 1 === +month && date.getUTCDate() === +day ? normalized : null;
}
