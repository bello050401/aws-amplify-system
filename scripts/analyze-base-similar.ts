/** 類似検索を実データで抜き打ち確認する（自分自身は除外して、他人が妥当に選ばれるか）。 */
import { readFileSync } from "node:fs";
import { extractProductIntro } from "@/lib/ai/productIntro/extract";
import { inferCategory } from "@/lib/ai/productIntro/styleProfile";
import { baseBrandHint, baseTitleCore, findSimilarArchivedProducts, type ArchivedStyleReference } from "@/lib/base/archive/similar";

const raw = JSON.parse(readFileSync(process.argv[2], "utf8")) as { items: { item_id: number | string; title: string; detail: string; price?: number }[] };

const archive: ArchivedStyleReference[] = [];
for (const it of raw.items) {
  const intro = extractProductIntro(it.detail);
  if (!intro.ok) continue;
  const titleCore = baseTitleCore(it.title);
  archive.push({
    baseItemId: String(it.item_id),
    titleCore,
    brand: baseBrandHint(it.title),
    category: inferCategory(it.title),
    price: typeof it.price === "number" ? it.price : null,
    introText: intro.intro,
  });
}
console.log(`archive=${archive.length}`);

const brandCounts = new Map<string, number>();
for (const a of archive) if (a.brand) brandCounts.set(a.brand, (brandCounts.get(a.brand) ?? 0) + 1);
console.log("top brands:", [...brandCounts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([b, n]) => `${b}(${n})`).join(", "));

// 抜き打ち: 先頭から間隔をあけて5件
let brandHitAtTop = 0;
let categoryHitAtTop = 0;
let evaluated = 0;
for (let i = 0; i < archive.length; i += Math.floor(archive.length / 5) || 1) {
  const target = archive[i];
  const pool = archive.filter((a) => a.baseItemId !== target.baseItemId);
  const hits = findSimilarArchivedProducts(
    { name: target.titleCore, brand: target.brand, category: target.category, price: target.price },
    pool,
    { limit: 5 },
  );
  evaluated++;
  if (hits[0] && target.brand && hits[0].reference.brand === target.brand) brandHitAtTop++;
  if (hits[0] && target.category && hits[0].reference.category === target.category) categoryHitAtTop++;
  console.log(`\n■ ${target.titleCore}  [brand=${target.brand} cat=${target.category} price=${target.price}]`);
  for (const h of hits) {
    console.log(`   ${String(h.score).padStart(4)}  ${h.reference.titleCore.slice(0, 46).padEnd(46)}  ${h.reasons.join(" / ")}`);
  }
}
console.log(`\n上位1件がブランド一致: ${brandHitAtTop}/${evaluated}  カテゴリ一致: ${categoryHitAtTop}/${evaluated}`);
