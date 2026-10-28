/** Start at the user's migration cutoff; older purchases require explicit dates. */
export function defaultYahooPurchaseRange(now = new Date()) {
  const to = now.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  const from = new Date(Date.parse(to + "T00:00:00Z") - 30 * 86400000)
    .toISOString().slice(0, 10);
  return { from: from < "2026-10-15" ? "2026-10-15" : from, to };
}
