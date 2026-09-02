/**
 * ZAICO同期の項目別「更新の優先順位」を決めるための実測。
 * 読み取り専用。
 */
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
const raw = new DynamoDBClient({ region: "us-west-2" });
const ddb = DynamoDBDocumentClient.from(raw);
const API = "j6up24p7lnczdmklzjdt3vrp4y";
let names: string[] | null = null;
async function all() { if (names) return names; const o: string[] = []; let s: string | undefined;
  do { const r = await raw.send(new ListTablesCommand({ ExclusiveStartTableName: s })); o.push(...(r.TableNames ?? [])); s = r.LastEvaluatedTableName; } while (s); return (names = o); }
async function scan(model: string, extra: any = {}) {
  const t = (await all()).find((n) => n.startsWith(`${model}-${API}-`));
  if (!t) { console.log(`(${model}: テーブルなし)`); return []; }
  const out: any[] = []; let k: any;
  do { const r: any = await ddb.send(new ScanCommand({ TableName: t, ExclusiveStartKey: k, ...extra })); out.push(...(r.Items ?? [])); k = r.LastEvaluatedKey; } while (k);
  return out;
}

function isZaicoActor(who: string | null | undefined): boolean {
  const s = String(who ?? "");
  return s.includes("ZAICO") || s.includes("zaico");
}

async function main() {
  // ── 1. InventoryHistory: 誰がどの項目を変えたか ──────────────
  const hist = await scan("InventoryHistory");
  console.log(`InventoryHistory: ${hist.length}件\n`);

  const byActorField = new Map<string, Map<string, number>>();
  const actors = new Map<string, number>();
  for (const h of hist) {
    const who = String(h.changedBy ?? "(不明)");
    const kind = isZaicoActor(who) ? "ZAICO同期" : "人";
    actors.set(who, (actors.get(who) ?? 0) + 1);
    if (!byActorField.has(kind)) byActorField.set(kind, new Map());
    const m = byActorField.get(kind)!;
    const f = String(h.fieldName ?? "(不明)");
    m.set(f, (m.get(f) ?? 0) + 1);
  }
  console.log("== changedBy の内訳 ==");
  for (const [k, v] of [...actors.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(6)}  ${k}`);

  for (const kind of ["人", "ZAICO同期"]) {
    const m = byActorField.get(kind);
    if (!m) continue;
    console.log(`\n== ${kind} が変更した項目 (上位40) ==`);
    for (const [f, c] of [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
      console.log(`  ${String(c).padStart(6)}  ${f}`);
    }
  }

  // ── 2. Inventory.updatedBy / createdBy ───────────────────────
  const inv = await scan("Inventory", { ProjectionExpression: "id, sku, updatedBy, createdBy, sourceSystem" });
  const upd = new Map<string, number>();
  for (const r of inv) upd.set(String(r.updatedBy ?? "(なし)"), (upd.get(String(r.updatedBy ?? "(なし)")) ?? 0) + 1);
  console.log(`\n== Inventory ${inv.length}件 の updatedBy ==`);
  for (const [k, v] of [...upd.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(v).padStart(6)}  ${k}`);
  const humanTouched = inv.filter((r) => !isZaicoActor(r.updatedBy));
  console.log(`\n最後に人が更新した在庫: ${humanTouched.length}件 / ${inv.length}件`);
}
main().catch((e) => { console.error(e); process.exit(1); });
