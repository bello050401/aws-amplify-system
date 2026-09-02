/**
 * BASE商品URLからBELLO在庫までの経路を、**実データで**通してみる調査。
 *
 * 指示書の実例 https://bellointeri.base.shop/items/156144635 を使い、
 *
 *   URL → 商品ID抽出 → BASE側データ照合 → BELLO在庫特定
 *
 * のどこまで通るか、どこで切れるかを確かめる。読み取りのみ。
 *
 * Run with: npm run probe:base-url
 */
import { extractProductReferences, extractUrls, extractBaseItemId, isBaseUrl } from "@/lib/inquiry/references";
import { serverDataClient, inventoryAuthMode } from "@/lib/amplify/dataClient";

const SAMPLE_ID = "156144635";
const SAMPLE_URL = `https://bellointeri.base.shop/items/${SAMPLE_ID}`;

const PATTERNS: [string, string][] = [
  ["通常URL", SAMPLE_URL],
  ["末尾スラッシュ", `${SAMPLE_URL}/`],
  ["クエリ付き", `${SAMPLE_URL}?utm_source=line&utm_medium=chat`],
  ["末尾に句点", `${SAMPLE_URL}。`],
  ["末尾に閉じ括弧", `（${SAMPLE_URL}）`],
  ["前後に文章", `こちらの商品について確認したいです。\n${SAMPLE_URL}\nサイズを教えてください。`],
  ["改行直後", `商品はこちら\n${SAMPLE_URL}\n以上です`],
  ["同じURLが2回", `${SAMPLE_URL} と ${SAMPLE_URL}`],
  ["複数URL", `${SAMPLE_URL} と https://bellointeri.base.shop/items/155832757`],
  ["BASE以外のURL", "https://example.com/items/999999999"],
  ["BASE以外＋BASE", `https://example.com/items/111 と ${SAMPLE_URL}`],
  ["URLなし", "アンティークチェアについて教えてください"],
  ["httpスキーム", SAMPLE_URL.replace("https://", "http://")],
  ["大文字ホスト", SAMPLE_URL.replace("bellointeri", "BelloInteri")],
];

async function main() {
  console.log("=== 1. URLから商品IDを取り出せるか ===\n");
  let extractionFailures = 0;
  for (const [label, text] of PATTERNS) {
    const urls = extractUrls(text);
    const baseUrls = urls.filter(isBaseUrl);
    const ids = baseUrls.map(extractBaseItemId).filter((v): v is string => v !== null);
    const uniqueIds = [...new Set(ids)];
    const expectSample = text.includes("bellointeri") || text.includes("BelloInteri");
    const ok = expectSample ? uniqueIds.includes(SAMPLE_ID) : true;
    if (!ok) extractionFailures++;
    console.log(
      `  ${ok ? "✓" : "✗"} ${label.padEnd(16)} URL${urls.length}件 / BASE${baseUrls.length}件 / ID=[${uniqueIds.join(", ")}]`,
    );
  }
  console.log(`\n  抽出の失敗: ${extractionFailures}件`);

  console.log("\n=== 2. extractProductReferences 経由（実際に使われる入口） ===\n");
  const ref = extractProductReferences(
    `こちらの商品について確認したいです。\n${SAMPLE_URL}\nサイズを教えてください。`,
    [],
  );
  console.log(`  baseItemIds : [${ref.baseItemIds.join(", ")}]`);
  console.log(`  urls        : ${ref.urls.length}件`);
  console.log(`  skus        : [${ref.skus.join(", ")}]`);

  console.log("\n=== 3. BASE側データに 156144635 があるか ===\n");
  const archive = await serverDataClient.models.BaseProductArchive.get(
    { baseItemId: SAMPLE_ID },
    inventoryAuthMode,
  );
  if (archive.errors) {
    console.log(`  BaseProductArchive 取得エラー: ${JSON.stringify(archive.errors)}`);
  } else if (!archive.data) {
    console.log(`  BaseProductArchive に ${SAMPLE_ID} は **無い**`);
  } else {
    const a = archive.data as unknown as Record<string, unknown>;
    console.log(`  BaseProductArchive にある`);
    console.log(`    title       : ${String(a.title ?? "-").slice(0, 60)}`);
    console.log(`    inventoryId : ${a.inventoryId ?? "(紐付けなし)"}`);
    console.log(`    price       : ${a.price ?? "-"}`);
  }

  const cache = await serverDataClient.models.BaseItemCache.get({ baseItemId: SAMPLE_ID }, inventoryAuthMode);
  console.log(`  BaseItemCache: ${cache.data ? "ある" : "無い"}`);

  console.log("\n=== 4. ChannelListing 経由でBELLO在庫へ辿れるか ===\n");
  const listings = await serverDataClient.models.ChannelListing.list({
    filter: { externalListingId: { eq: SAMPLE_ID } },
    limit: 50,
    ...inventoryAuthMode,
  });
  console.log(`  externalListingId = ${SAMPLE_ID} の ChannelListing: ${listings.data?.length ?? 0}件`);

  console.log("\n=== 5. BaseProductArchive の全体像 ===\n");
  const all = await serverDataClient.models.BaseProductArchive.list({ limit: 1000, ...inventoryAuthMode });
  const rows = (all.data ?? []) as unknown as Record<string, unknown>[];
  console.log(`  総件数        : ${rows.length}`);
  const linked = rows.filter((r) => r.inventoryId).length;
  console.log(`  在庫紐付けあり: ${linked}`);
  console.log(`  在庫紐付けなし: ${rows.length - linked}`);
  if (rows.length > 0) {
    const ids = rows.map((r) => String(r.baseItemId)).sort();
    console.log(`  baseItemId の範囲: ${ids[0]} 〜 ${ids[ids.length - 1]}`);
  }
}

void main();
