/**
 * ShippingRate(家財おまかせ便 料金マスタ)を **Stagingの実データで** 数え、
 * 「登録済みなのにUIがデータ不足と言う」不具合が再発していないことを
 * 検査する(2026-09-02 指示書§14-§17)。
 *
 * 読み取り専用。DynamoDBのScanしか行わない。
 *
 *   AWS_PROFILE=Bello npm run verify:shipping-live
 */
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { SHIPPING_RANKS } from "@/lib/shipping/rank";

const REGION = process.env.AWS_REGION || "us-west-2";
const raw = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(raw);

let failures = 0;
let passes = 0;
function check(ok: boolean, label: string, detail = "") {
  if (ok) { passes++; console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failures++; console.error(`✗ FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

let cachedNames: string[] | null = null;
async function listAllTableNames(): Promise<string[]> {
  if (cachedNames) return cachedNames;
  const names: string[] = [];
  let start: string | undefined;
  do {
    const res = await raw.send(new ListTablesCommand({ ExclusiveStartTableName: start }));
    names.push(...(res.TableNames ?? []));
    start = res.LastEvaluatedTableName;
  } while (start);
  return (cachedNames = names);
}

/** 必要なモデルが揃っている apiId を選ぶ(件数で選ばない — 空の残骸テーブルが同居している)。 */
const REQUIRED_MODELS = ["ShippingRate", "Inventory", "ZaicoSourceLink"];
async function resolveTable(model: string): Promise<string> {
  if (process.env.BELLO_SHIPPING_RATE_TABLE && model === "ShippingRate") return process.env.BELLO_SHIPPING_RATE_TABLE;
  const names = await listAllTableNames();
  const byApiId = new Map<string, Set<string>>();
  for (const n of names) {
    const m = /^([A-Za-z0-9]+)-([a-z0-9]{20,})-/.exec(n);
    if (!m) continue;
    if (!byApiId.has(m[2])) byApiId.set(m[2], new Set());
    byApiId.get(m[2])!.add(m[1]);
  }
  const complete = [...byApiId.entries()].filter(([, s]) => REQUIRED_MODELS.every((r) => s.has(r))).map(([a]) => a);
  if (complete.length !== 1) throw new Error(`Amplify Data APIを一意に決められません(候補${complete.length}件)。BELLO_SHIPPING_RATE_TABLEで明示してください。`);
  const hits = names.filter((n) => n.startsWith(`${model}-${complete[0]}-`));
  if (hits.length !== 1) throw new Error(`${model} のテーブルを一意に決められません。`);
  return hits[0];
}

interface Row { rank: string; destinationPrefecture: string; destinationArea: string | null; price: number | null; verifiedAt: string | null }

async function scanAll(table: string): Promise<Row[]> {
  const out: Row[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key }));
    out.push(...((res.Items ?? []) as unknown as Row[]));
    key = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (key);
  return out;
}

/** 代表地域(UIが「データ不足」と出していた3地域)。 */
const REPRESENTATIVE = ["東京都", "愛知県", "大阪府"];

async function main() {
  const table = await resolveTable("ShippingRate");
  console.log(`table = ${table}\n`);

  const rows = await scanAll(table);
  console.log(`── 実測 ────────────────────────────────────────────`);
  console.log(`総件数: ${rows.length}`);

  const byRank = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byRank.get(r.rank) ?? [];
    list.push(r);
    byRank.set(r.rank, list);
  }
  const destinations = new Set(rows.map((r) => `${r.destinationPrefecture}/${r.destinationArea ?? ""}`));
  console.log(`宛先(都道府県+地域細分)の種類: ${destinations.size}`);
  console.log(`rank別: ${[...byRank.entries()].sort().map(([k, v]) => `${k}=${v.length}`).join(" ")}`);
  console.log(`price=null(サービス対象外): ${rows.filter((r) => r.price == null).length}`);
  console.log(`verifiedAt=null: ${rows.filter((r) => r.verifiedAt == null).length}\n`);

  console.log(`── 検査 ────────────────────────────────────────────`);
  const definedRanks = SHIPPING_RANKS.filter((r) => r !== "OVERSIZE");
  check(rows.length > 0, "ShippingRateにデータが存在する", `${rows.length}件`);
  check(
    definedRanks.every((r) => (byRank.get(r)?.length ?? 0) > 0),
    "全ランクに料金が登録されている",
    definedRanks.map((r) => `${r}:${byRank.get(r)?.length ?? 0}`).join(" "),
  );
  check(
    definedRanks.every((r) => new Set(byRank.get(r)?.map((x) => `${x.destinationPrefecture}/${x.destinationArea ?? ""}`)).size === destinations.size),
    "どのランクも同じ宛先集合を持つ(欠けたランクが無い)",
  );
  check(rows.every((r) => r.verifiedAt != null), "全行にverifiedAtがある(未検証扱いで除外される行が無い)");

  // ★ 本題: 代表地域が全ランクで引けること。
  for (const pref of REPRESENTATIVE) {
    const missing = definedRanks.filter((rank) => !rows.some((r) => r.destinationPrefecture === pref && r.rank === rank && r.price != null));
    check(missing.length === 0, `${pref} は全ランクで料金が引ける`, missing.length ? `欠けているランク: ${missing.join(",")}` : "");
  }

  // ★ 「1ページだけ読むと取りこぼす」ことを実測で示す(回帰の証拠として残す)。
  console.log(`\n── 1ページだけ読んだ場合(旧実装の再現) ─────────────`);
  for (const rank of ["B", "C"]) {
    const res = await ddb.send(
      new ScanCommand({
        TableName: table,
        Limit: 100,
        FilterExpression: "#r = :v",
        ExpressionAttributeNames: { "#r": "rank" },
        ExpressionAttributeValues: { ":v": rank },
      }),
    );
    const got = (res.Items ?? []) as unknown as Row[];
    const prefs = new Set(got.map((g) => g.destinationPrefecture));
    const total = byRank.get(rank)?.length ?? 0;
    console.log(
      `  rank=${rank}: 1ページ=${got.length}件 / 実際=${total}件 / scanned=${res.ScannedCount} / 続きあり=${!!res.LastEvaluatedKey}` +
        `  代表地域: ${REPRESENTATIVE.map((p) => `${p}=${prefs.has(p)}`).join(" ")}`,
    );
    check(
      got.length < total,
      `rank=${rank}: 1ページでは全件を取得できない(全ページ辿る実装が必要であることの実測)`,
      `${got.length} < ${total}`,
    );
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
