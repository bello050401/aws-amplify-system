/**
 * BASE過去商品をDynamoDBの BaseProductArchive へ入れる(再実行安全)。
 *
 * ## 再同期で重複を作らない
 *
 * 識別子はBASEの item_id そのもの(モデルの .identifier(["baseItemId"]))。
 * 同じ商品を何度同期しても行は1つで、内容が更新されるだけ。
 *
 * ## 元データを書き換えない
 *
 * BASEから受け取った説明文は detailRaw へそのまま入れる。分析に使う
 * 平文・紹介文・セクション分解は別フィールドへ持ち、原文は触らない。
 *
 * Run: AWS_PROFILE=Bello node scripts/with-server-only-stub.cjs scripts/sync-base-archive.ts <items.json>
 */
import { readFileSync } from "node:fs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, BatchWriteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { extractProductIntro } from "@/lib/ai/productIntro/extract";
import { splitBaseDescription, toPlainText } from "@/lib/base/archive/sections";
import { baseBrandHint, baseTitleCore } from "@/lib/base/archive/similar";
import { inferCategory } from "@/lib/ai/productIntro/styleProfile";

const TABLE = process.env.BASE_ARCHIVE_TABLE || "BaseProductArchive-j6up24p7lnczdmklzjdt3vrp4y-NONE";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || "us-west-2" }));

interface RawItem {
  item_id: number | string;
  title: string;
  detail: string;
  price?: number;
  proper_price?: number;
  stock?: number;
  visible?: number;
  modified?: number;
  variations?: unknown;
  [k: string]: unknown;
}

function imageUrls(it: RawItem): string[] {
  const urls: string[] = [];
  for (let i = 1; i <= 20; i++) {
    const v = it[`img${i}_origin`];
    if (typeof v === "string" && v.trim()) urls.push(v);
  }
  return urls;
}

async function main() {
  const raw = JSON.parse(readFileSync(process.argv[2], "utf8")) as { items: RawItem[] };
  const now = new Date().toISOString();
  const rows = raw.items.map((it) => {
    const sections = splitBaseDescription(it.detail);
    const intro = extractProductIntro(it.detail);
    const titleCore = baseTitleCore(it.title ?? "");
    return {
      baseItemId: String(it.item_id),
      title: it.title ?? "",
      detailRaw: it.detail ?? "",
      detailText: toPlainText(it.detail),
      introText: intro.ok ? intro.intro : null,
      sectionsJson: JSON.stringify(sections.map((s) => ({ kind: s.kind, heading: s.heading, order: s.order, length: s.body.length }))),
      price: typeof it.price === "number" ? it.price : null,
      properPrice: typeof it.proper_price === "number" ? it.proper_price : null,
      stock: typeof it.stock === "number" ? it.stock : null,
      visible: it.visible === 1,
      modifiedAt: it.modified ? new Date(it.modified * 1000).toISOString() : null,
      imageUrlsJson: JSON.stringify(imageUrls(it)),
      variationsJson: JSON.stringify(it.variations ?? []),
      itemUrl: null,
      brandHintsJson: JSON.stringify([baseBrandHint(it.title ?? "")].filter(Boolean)),
      titleCore,
      syncedAt: now,
      createdAt: now,
      updatedAt: now,
      __typename: "BaseProductArchive",
    };
  });

  let written = 0;
  for (let i = 0; i < rows.length; i += 25) {
    const chunk = rows.slice(i, i + 25);
    let unprocessed = { [TABLE]: chunk.map((Item) => ({ PutRequest: { Item } })) } as Record<string, { PutRequest: { Item: Record<string, unknown> } }[]>;
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: unprocessed }));
      const left = res.UnprocessedItems?.[TABLE] ?? [];
      if (left.length === 0) break;
      // 書けなかったぶんだけを、待ってから再送する(取りこぼしを黙って捨てない)。
      unprocessed = { [TABLE]: left as never };
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
    written += chunk.length;
    process.stdout.write(`\r書き込み: ${written}/${rows.length}`);
  }
  console.log("");

  // 実際に何行入ったかを、書いたつもりの件数ではなく表を数えて確認する。
  let count = 0;
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: TABLE, Select: "COUNT", ExclusiveStartKey: key }));
    count += res.Count ?? 0;
    key = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (key);

  const withIntro = rows.filter((r) => r.introText).length;
  const times = rows.map((r) => r.modifiedAt).filter(Boolean).sort() as string[];
  console.log(JSON.stringify({
    sourceItems: rows.length,
    tableCount: count,
    withIntro,
    withoutIntro: rows.length - withIntro,
    period: { start: times[0] ?? null, end: times[times.length - 1] ?? null },
  }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
