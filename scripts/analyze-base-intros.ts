/** 抽出済みの「商品のご紹介」本文だけを対象に、文体の実測値を出す。 */
import { readFileSync } from "node:fs";
import { extractProductIntro } from "@/lib/ai/productIntro/extract";

const raw = JSON.parse(readFileSync(process.argv[2], "utf8")) as { items: { item_id: string | number; title: string; detail: string }[] };
const intros: string[] = [];
for (const it of raw.items) {
  const r = extractProductIntro(it.detail);
  if (r.ok) intros.push(r.intro);
}

const paraCounts = intros.map((t) => t.split(/\n{2,}/).filter((p) => p.trim()).length).sort((a, b) => a - b);
const lineCounts = intros.map((t) => t.split("\n").filter((l) => l.trim()).length).sort((a, b) => a - b);
const sentCounts = intros.map((t) => (t.match(/[。！？]/g) || []).length).sort((a, b) => a - b);

function med(a: number[]) { return a[Math.floor(a.length / 2)]; }

// 文末表現
const endings = new Map<string, number>();
for (const t of intros) {
  for (const s of t.split(/(?<=[。！？])/)) {
    const m = /([ぁ-んァ-ヶ一-龥ー]{2,8}[。！？])\s*$/.exec(s.trim());
    if (m) endings.set(m[1], (endings.get(m[1]) ?? 0) + 1);
  }
}
// 冒頭表現
const openers = new Map<string, number>();
for (const t of intros) {
  const first = t.split("\n").find((l) => l.trim())?.trim() ?? "";
  const head = first.slice(0, 12);
  if (head) openers.set(head, (openers.get(head) ?? 0) + 1);
}
// 頻出フレーズ(4-gram以上の日本語連続)
const phrases = new Map<string, number>();
for (const t of intros) {
  const clean = t.replace(/\s+/g, "");
  for (let n = 6; n <= 12; n++) {
    for (let i = 0; i + n <= clean.length; i++) {
      const g = clean.slice(i, i + n);
      if (!/^[ぁ-んァ-ヶ一-龥ー、。]+$/.test(g)) continue;
      phrases.set(g, (phrases.get(g) ?? 0) + 1);
    }
  }
}
const topPhrases = [...phrases.entries()].filter(([, n]) => n >= 15).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, 30);

// 記号の使用
const symbolUse: Record<string, number> = {};
for (const sym of ["◎", "●", "■", "★", "☆", "・", "！", "♪", "※", "→"]) {
  symbolUse[sym] = intros.filter((t) => t.includes(sym)).length;
}

console.log(JSON.stringify({
  introCount: intros.length,
  charLength: { min: Math.min(...intros.map((t) => t.length)), median: med(intros.map((t) => t.length).sort((a, b) => a - b)), max: Math.max(...intros.map((t) => t.length)) },
  paragraphs: { min: paraCounts[0], median: med(paraCounts), max: paraCounts[paraCounts.length - 1] },
  lines: { min: lineCounts[0], median: med(lineCounts), max: lineCounts[lineCounts.length - 1] },
  sentences: { min: sentCounts[0], median: med(sentCounts), max: sentCounts[sentCounts.length - 1] },
  topEndings: [...endings.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18),
  topOpeners: [...openers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
  topPhrases,
  symbolUse,
}, null, 1));
