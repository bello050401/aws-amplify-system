/**
 * 取得済みのBASE過去商品(JSON)に対して、既存の extractProductIntro を
 * そのまま当ててみて、どれだけ「商品のご紹介」を切り出せるかを実測する。
 *
 * 目的は corpus を作ることではなく、**既存の抽出器が実データに通用するか**
 * を先に測ること。Inventory由来では 2,920件中137件しか取れていなかったので、
 * BASEの実説明文でも同じ取りこぼし方をするなら、抽出器の側を直す必要がある。
 */
import { readFileSync } from "node:fs";
import { extractProductIntro } from "@/lib/ai/productIntro/extract";

interface RawItem {
  item_id: number | string;
  title: string;
  detail: string;
}

const file = process.argv[2];
const raw = JSON.parse(readFileSync(file, "utf8")) as { count: number; items: RawItem[] };

const failures: Record<string, number> = {};
const sources: Record<string, number> = {};
let ok = 0;
const lengths: number[] = [];
const failureSamples: Record<string, string[]> = {};

for (const item of raw.items) {
  const result = extractProductIntro(item.detail);
  if (result.ok) {
    ok++;
    sources[result.source] = (sources[result.source] ?? 0) + 1;
    lengths.push(result.intro.length);
  } else {
    failures[result.reason] = (failures[result.reason] ?? 0) + 1;
    (failureSamples[result.reason] ??= []).push(String(item.item_id));
  }
}

lengths.sort((a, b) => a - b);
console.log(JSON.stringify({
  total: raw.items.length,
  extracted: ok,
  extractionRate: `${((ok / raw.items.length) * 100).toFixed(1)}%`,
  bySource: sources,
  failures,
  introLength: lengths.length ? { min: lengths[0], median: lengths[Math.floor(lengths.length / 2)], max: lengths[lengths.length - 1] } : null,
  failureSampleIds: Object.fromEntries(Object.entries(failureSamples).map(([k, v]) => [k, v.slice(0, 3)])),
}, null, 2));
