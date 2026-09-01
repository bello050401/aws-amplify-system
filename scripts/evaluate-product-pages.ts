/**
 * 在庫から商品ページを実際に生成して、品質を機械的に評価する(§8)。
 *
 * 「生成できた」ではなく「BELLOの型に沿っていて、事実を捏造していない」
 * ことを確かめるのが目的。カテゴリ・ブランドが偏らないように選ぶ。
 *
 * Run: AWS_PROFILE=Bello node scripts/with-server-only-stub.cjs scripts/evaluate-product-pages.ts [件数]
 */
import { writeFileSync } from "node:fs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { generateProductPage } from "@/lib/ai/productPage/service";
import { inferCategory, type BelloStyleProfile } from "@/lib/ai/productIntro/styleProfile";
import { baseBrandHint, type ArchivedStyleReference } from "@/lib/base/archive/similar";

const SUFFIX = "j6up24p7lnczdmklzjdt3vrp4y-NONE";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || "us-west-2" }));

async function scanAll(table: string, limit?: number): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key }));
    out.push(...((res.Items ?? []) as Record<string, unknown>[]));
    key = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (limit && out.length >= limit) break;
  } while (key);
  return out;
}

/** 紹介文に寸法が並んでいないか(要件の中心)。 */
const DIMENSION_PATTERN = /(?:[WDHwdh]\s*[:：]?\s*\d|[幅奥行高][さきみ]?\s*[:：]?\s*\d|\d+\s*[×x]\s*\d+)/;

async function main() {
  const wanted = Number(process.argv[2] ?? 12);

  const archiveRows = await scanAll(`BaseProductArchive-${SUFFIX}`);
  const archive: ArchivedStyleReference[] = archiveRows
    .filter((r) => r.introText)
    .map((r) => ({
      baseItemId: String(r.baseItemId),
      titleCore: String(r.titleCore ?? r.title ?? ""),
      brand: baseBrandHint(String(r.title ?? "")),
      category: inferCategory(String(r.title ?? "")),
      price: typeof r.price === "number" ? r.price : null,
      introText: String(r.introText),
    }));

  const profileRows = await scanAll(`BelloStyleProfile-${SUFFIX}`);
  const active = profileRows.find((r) => r.isActive === true);
  const styleProfile: BelloStyleProfile | null = active ? (JSON.parse(String(active.profileJson)) as BelloStyleProfile) : null;
  const styleProfileVersion = active ? Number(active.version) : null;

  console.log(`archive=${archive.length} styleProfileVersion=${styleProfileVersion}`);

  const inventory = await scanAll(`Inventory-${SUFFIX}`);
  // カテゴリが偏らないよう、推定カテゴリごとに散らして選ぶ。
  const byCategory = new Map<string, Record<string, unknown>[]>();
  for (const row of inventory) {
    const name = String(row.name ?? "");
    if (!name.trim()) continue;
    if (!row.damageNotes && !row.width && !row.height) continue; // 事実が何も無い行は評価にならない
    const cat = inferCategory(name) ?? "その他";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(row);
  }
  const picked: Record<string, unknown>[] = [];
  const cats = [...byCategory.keys()];
  for (let round = 0; picked.length < wanted && round < 50; round++) {
    for (const c of cats) {
      const list = byCategory.get(c)!;
      if (round < list.length && picked.length < wanted) picked.push(list[round]);
    }
  }
  console.log(`evaluating ${picked.length} items across ${cats.length} categories`);

  const results: Record<string, unknown>[] = [];
  for (const row of picked) {
    const name = String(row.name ?? "");
    const res = await generateProductPage({
      inventoryId: String(row.id),
      name,
      categoryName: inferCategory(name),
      width: row.width ? String(row.width) : null,
      height: row.height ? String(row.height) : null,
      damageNotes: row.damageNotes ? String(row.damageNotes) : null,
      note: row.note ? String(row.note) : null,
      stockQuantity: typeof row.quantity === "number" ? row.quantity : null,
      sku: row.sku ? String(row.sku) : null,
      price: typeof row.salePrice === "number" ? row.salePrice : null,
      brand: baseBrandHint(name),
      archive,
      styleProfile,
      styleProfileVersion,
    });

    const intro = res.sections?.introduction ?? "";
    const full = res.fullDescription ?? "";
    const checks = {
      generated: res.ok,
      hasIntroHeading: full.includes("◎商品のご紹介"),
      introHasNoDimensions: !DIMENSION_PATTERN.test(intro),
      introLength: intro.length,
      politeEnding: /(?:です|ます)[。]/.test(intro),
      noExclamation: !/[!！]/.test(full),
      noStockMention: !/在庫|残り\d|点のみ/.test(full),
      violations: res.violations.map((v) => v.code),
      missingFacts: res.missingFacts,
      referenced: res.referencedBaseItemIds.length,
    };
    results.push({ inventoryId: row.id, name: name.slice(0, 60), category: inferCategory(name), checks, title: res.sections?.title, intro: intro.slice(0, 200), failureReason: res.failureReason });
    const mark = res.ok && checks.hasIntroHeading && checks.introHasNoDimensions ? "OK " : "NG ";
    console.log(`${mark} ${String(intro.length).padStart(4)}字  ref=${checks.referenced}  ${name.slice(0, 44)}  ${res.failureReason ? "← " + res.failureReason.slice(0, 70) : ""}`);
  }

  const pass = results.filter((r) => {
    const c = r.checks as Record<string, unknown>;
    return c.generated && c.hasIntroHeading && c.introHasNoDimensions && c.noExclamation && c.noStockMention;
  }).length;

  const summary = {
    evaluated: results.length,
    passedAllChecks: pass,
    generated: results.filter((r) => (r.checks as Record<string, unknown>).generated).length,
    hasIntroHeading: results.filter((r) => (r.checks as Record<string, unknown>).hasIntroHeading).length,
    introHasNoDimensions: results.filter((r) => (r.checks as Record<string, unknown>).introHasNoDimensions).length,
    noExclamation: results.filter((r) => (r.checks as Record<string, unknown>).noExclamation).length,
    noStockMention: results.filter((r) => (r.checks as Record<string, unknown>).noStockMention).length,
    categories: [...new Set(results.map((r) => r.category))],
    // 同じ文章を使い回していないか(先頭60字が全件で異なること)
    distinctIntros: new Set(results.map((r) => String(r.intro).slice(0, 60))).size,
  };
  console.log("\n" + JSON.stringify(summary, null, 1));
  writeFileSync(process.env.EVAL_OUT || "product-page-eval.json", JSON.stringify({ summary, results }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
