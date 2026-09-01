import { readFileSync } from "node:fs";
import { splitBaseDescription } from "@/lib/base/archive/sections";
const raw = JSON.parse(readFileSync(process.argv[2], "utf8")) as { items: { detail: string }[] };
const kindCount = new Map<string, number>();
const kindOrder = new Map<string, number[]>();
let noHeading = 0;
for (const it of raw.items) {
  const secs = splitBaseDescription(it.detail);
  if (secs.length === 0) { noHeading++; continue; }
  const seen = new Set<string>();
  for (const s of secs) {
    if (seen.has(s.kind)) continue;
    seen.add(s.kind);
    kindCount.set(s.kind, (kindCount.get(s.kind) ?? 0) + 1);
    if (!kindOrder.has(s.kind)) kindOrder.set(s.kind, []);
    kindOrder.get(s.kind)!.push(s.order);
  }
}
const rows = [...kindCount.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => {
  const o = kindOrder.get(k)!;
  return { kind: k, count: n, pct: `${((n / raw.items.length) * 100).toFixed(0)}%`, avgOrder: (o.reduce((a, b) => a + b, 0) / o.length).toFixed(1) };
});
console.log(JSON.stringify({ total: raw.items.length, noSections: noHeading, rows }, null, 1));
