/**
 * 夜間統合指示書(2026-09-01) §4.3/§4.5: BELLOの過去の商品説明から
 * 「商品のご紹介」だけを抽出し、文体資料(style corpus)として
 * `lib/ai/productIntro/styleCorpus.generated.json` へ書き出す。
 *
 * Run with: AWS_PROFILE=Bello npm run build:style-corpus [最大件数]
 *
 * ## なぜ実行時ではなくビルド成果物なのか
 *
 * 文体例は生成のたびに必要になるが、そのたびにInventoryをスキャンすると
 * 生成1回ごとに数千件のreadが走る(§6.2の性能要件に反する)。文体は
 * 頻繁に変わるものではないので、ここで一度作って成果物として持ち、
 * 実行時は静的に読むだけにする。BASE連携が有効になったら、同じ抽出処理を
 * BASEのdescriptionに対しても回して corpus を差し替えられる
 * (extractProductIntro は入力がどちらでも同じように動く)。
 *
 * ## 安全性
 *
 * 成果物はリポジトリにコミットされるため、次を必ず通す:
 *
 *   - extractProductIntro が定型文・社内情報混じりの塊を弾く。
 *   - さらにここで looksLikePersonalData を再チェックし、住所・電話番号を
 *     含む文章は corpus へ入れない(二重の網)。
 *   - 商品名は sanitizeProductName で `【…】` の社内マーカー
 *     (顧客の氏名・在庫数等が入る)を落としてから記録する。
 *
 * 入るのはBELLO自身が書いた**顧客向けの商品紹介文**だけで、
 * 社内メモ・価格・個人情報は入らない。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { buildStyleCorpus, deriveStyleGuide, type StyleSourceRow } from "@/lib/ai/productIntro/styleGuide";
import { containsPriceMention, looksLikePersonalData, sanitizeProductName } from "@/lib/ai/productIntro/facts";

const REGION = process.env.AWS_REGION || "us-west-2";
const raw = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(raw);

const OUTPUT_PATH = join(process.cwd(), "lib", "ai", "productIntro", "styleCorpus.generated.json");

async function resolveInventoryTable(): Promise<string> {
  if (process.env.BELLO_INVENTORY_TABLE) return process.env.BELLO_INVENTORY_TABLE;
  const names: string[] = [];
  let start: string | undefined;
  do {
    const res = await raw.send(new ListTablesCommand({ ExclusiveStartTableName: start }));
    names.push(...(res.TableNames ?? []));
    start = res.LastEvaluatedTableName;
  } while (start);
  const byApiId = new Map<string, Set<string>>();
  for (const n of names) {
    const m = /^([A-Za-z0-9]+)-([a-z0-9]{20,})-/.exec(n);
    if (!m) continue;
    if (!byApiId.has(m[2])) byApiId.set(m[2], new Set());
    byApiId.get(m[2])!.add(m[1]);
  }
  const complete = [...byApiId.entries()].filter(([, s]) => s.has("Inventory") && s.has("ZaicoSourceLink")).map(([a]) => a);
  if (complete.length !== 1) throw new Error(`Inventoryテーブルを一意に決められません(候補${complete.length}件)。BELLO_INVENTORY_TABLEで明示してください。`);
  return names.find((n) => n.startsWith(`Inventory-${complete[0]}-`))!;
}

/**
 * BASEのアーカイブJSONから読む経路。
 *
 * 【なぜこちらを使うのか — 実測】Inventory.note から作った当初の corpus は
 * 2,920件中137件(4.7%)しか紹介文を取り出せなかった。同じ抽出器を実際の
 * BASE説明文へ当てると **267件中267件(100%)** 取れる。在庫のnoteは社内
 * メモで、BASEの説明文こそがBELLOが顧客へ向けて書いた文章なので、文体の
 * 手本にすべきはこちら。このファイル冒頭のコメントが「BASE連携が有効に
 * なったら同じ抽出処理をBASEへ回して corpus を差し替えられる」と書いて
 * いた、まさにその差し替えにあたる。
 */
function loadBaseRows(file: string): StyleSourceRow[] {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { items: { item_id: number | string; title: string; detail: string }[] };
  return parsed.items.map((it) => ({
    id: `base:${it.item_id}`,
    name: sanitizeProductName(it.title ?? "").name,
    description: it.detail,
  }));
}

async function main() {
  const args = process.argv.slice(2);
  const fromBaseIndex = args.indexOf("--from-base");
  const fromBaseFile = fromBaseIndex >= 0 ? args[fromBaseIndex + 1] : null;
  const maxExamples = Number(args.find((a) => /^[0-9]+$/.test(a)) ?? 40);

  if (fromBaseFile) {
    const baseRows = loadBaseRows(fromBaseFile);
    console.log(`BASEアーカイブ: ${baseRows.length}件`);
    await emit(baseRows, maxExamples);
    return;
  }

  const table = await resolveInventoryTable();
  console.log(`inventory=${table}`);

  const rows: StyleSourceRow[] = [];
  let key: Record<string, unknown> | undefined;
  let scanned = 0;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: table,
        ProjectionExpression: "id, #n, note, deletedAt",
        ExpressionAttributeNames: { "#n": "name" },
        ExclusiveStartKey: key,
      }),
    );
    for (const item of (res.Items ?? []) as Array<{ id: string; name?: string; note?: string; deletedAt?: string }>) {
      scanned++;
      if (item.deletedAt) continue;
      if (!item.note || !item.name) continue;
      rows.push({ id: item.id, name: sanitizeProductName(item.name).name, description: item.note });
    }
    key = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (key);

  console.log(`スキャン: ${scanned}件 / note付き: ${rows.length}件`);
  await emit(rows, maxExamples);
}

async function emit(rows: StyleSourceRow[], maxExamples: number) {
  const { examples, stats } = buildStyleCorpus(rows);

  // 二重の網: 抽出できた文章にも、corpus へ入れたくないものが残っていないかを再確認する。
  let excludedPii = 0;
  let excludedPrice = 0;
  const safe = examples.filter((e) => {
    if (looksLikePersonalData(e.intro)) {
      console.warn(`  [除外] 個人情報らしき記述を含むため corpus へ入れません: inventoryId=${e.inventoryId}`);
      excludedPii++;
      return false;
    }
    // 金額を含む紹介文は文体資料に向かない —— 「説明文に価格を書く」という
    // 書き方自体を手本にしてしまう。実際に初回生成では、これを手本にした
    // であろう「定価42000円のところ、販売価格18000円で…」という文が出た。
    if (containsPriceMention(e.intro)) {
      excludedPrice++;
      return false;
    }
    return true;
  });

  // 同一文面の重複を落とす。同じ商品を別名で二重登録している行があり、
  // そのままだと限られた例の枠を同じ文章で埋めてしまう。
  const seen = new Set<string>();
  const deduped = safe.filter((e) => {
    const key = e.intro.replace(/\s+/g, "").slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 長い順ではなく、程よい長さのものを優先する(極端に長い例に引っ張られない)。
  //
  // 目標の長さは固定値ではなく**実測の中央値**にする。以前は 220 が直接
  // 書かれていたが、これは在庫のnoteから作った corpus の中央値(159字)に
  // 合わせた数字で、BASEの実説明文(中央値421字)へ当てると「短い例ばかりが
  // 選ばれる」方向に偏る。母集団が変われば目標も変わるべき。
  const sortedLengths = deduped.map((e) => e.intro.length).sort((a, b) => a - b);
  const targetLength = sortedLengths.length ? sortedLengths[Math.floor(sortedLengths.length / 2)] : 220;
  console.log(`例文の目標長: ${targetLength}字(実測の中央値)`);
  const picked = deduped
    .slice()
    .sort((a, b) => Math.abs(a.intro.length - targetLength) - Math.abs(b.intro.length - targetLength))
    .slice(0, maxExamples);

  const guide = deriveStyleGuide(picked, stats);

  const payload = {
    _comment:
      "自動生成ファイル。編集しないこと。`npm run build:style-corpus` で再生成する。BELLOが過去に書いた顧客向けの商品紹介文だけを含み、社内メモ・価格・個人情報は抽出時と書き出し時の二重チェックで除外している。",
    guide,
    examples: picked,
  };

  writeFileSync(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(`\n抽出結果:`);
  console.log(`  試行         : ${stats.attempted}件`);
  console.log(`  抽出成功     : ${stats.extracted}件`);
  console.log(`  個人情報で除外: ${excludedPii}件`);
  console.log(`  金額を含み除外: ${excludedPrice}件`);
  console.log(`  重複で除外   : ${safe.length - deduped.length}件`);
  console.log(`  corpus採用   : ${picked.length}件`);
  console.log(`  失敗の内訳   :`);
  for (const [reason, n] of Object.entries(stats.failures).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${reason}: ${n}`);
  }
  console.log(`\n  平均文字数   : ${guide.averageLength}`);
  console.log(`  平均段落数   : ${guide.averageParagraphs}`);
  console.log(`\n書き出し: ${OUTPUT_PATH}`);
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
