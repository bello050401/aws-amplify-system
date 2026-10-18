/** User default: one calendar day, 21:00 JST. At late-night publication use the
 * next 21:00 satisfying Yahoo's minimum 12/13-hour duration. */
export function defaultYahooEndAt(now = Date.now()): string {
  const jst = new Date(now + 9 * 3600_000);
  const day = new Date(
    Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate() + 1, 21),
  );
  return day.toISOString().slice(0, 16);
}
export function resolvedYahooEndAt(
  input: { endAtJst: string; automaticEnd?: boolean },
  now = Date.now(),
): string {
  return input.automaticEnd === false ? input.endAtJst : defaultYahooEndAt(now);
}
