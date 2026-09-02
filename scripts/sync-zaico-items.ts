/**
 * ZAICOの**指定した数件だけ**を同期し、マッピング修正が実データへ届くことを
 * 確かめるためのスクリプト(2026-09-02 追加仕様§19「実在商品で検証」)。
 *
 * 全件同期(5,313件)は別物 —— あれは ZaicoSyncJob を立てて
 * zaico-sync-worker が5分ごとに進める仕組みで、ここでは行わない。
 * ここは「この商品IDだけを今すぐ1回」。
 *
 * 使い方(既定は dry-run。実際に書き込むには --apply が要る):
 *
 *   AWS_PROFILE=Bello ZAICO_IDS=73116696,73116698 \
 *     node scripts/with-server-only-stub.cjs scripts/sync-zaico-items.ts
 *
 *   AWS_PROFILE=Bello ZAICO_IDS=73116696 \
 *     node scripts/with-server-only-stub.cjs scripts/sync-zaico-items.ts --apply
 *
 * dry-run では ZAICO の生の値と、マッピング後に BELLO のどの項目へ
 * 何が入るかを表示するだけで、DynamoDB へは一切書き込まない。
 */
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { getInventory } from "@/lib/zaico/client";
import { mapZaicoCoreFields, mapZaicoOptionalAttributes } from "@/lib/inventory/zaicoMapping";

const APPLY = process.argv.includes("--apply");
const IDS = (process.env.ZAICO_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const REGION = process.env.AWS_REGION || "us-west-2";

const raw = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(raw);

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

const REQUIRED_MODELS = ["Inventory", "ZaicoSourceLink", "ShippingRate"];
async function inventoryTable(): Promise<string> {
  if (process.env.BELLO_INVENTORY_TABLE) return process.env.BELLO_INVENTORY_TABLE;
  const names = await listAllTableNames();
  const byApiId = new Map<string, Set<string>>();
  for (const n of names) {
    const m = /^([A-Za-z0-9]+)-([a-z0-9]{20,})-/.exec(n);
    if (!m) continue;
    if (!byApiId.has(m[2])) byApiId.set(m[2], new Set());
    byApiId.get(m[2])!.add(m[1]);
  }
  const complete = [...byApiId.entries()].filter(([, s]) => REQUIRED_MODELS.every((r) => s.has(r))).map(([a]) => a);
  if (complete.length !== 1) throw new Error(`Amplify Data APIを一意に決められません(候補${complete.length}件)`);
  const hits = names.filter((n) => n.startsWith(`Inventory-${complete[0]}-`));
  if (hits.length !== 1) throw new Error("Inventory テーブルを一意に決められません");
  return hits[0];
}

async function findBySourceId(table: string, sourceInventoryId: string): Promise<Record<string, unknown> | null> {
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: "sourceInventoryId = :s AND sourceSystem = :z",
        ExpressionAttributeValues: { ":s": sourceInventoryId, ":z": "ZAICO" },
        ExclusiveStartKey: key,
      }),
    );
    const hit = (res.Items ?? [])[0];
    if (hit) return hit as Record<string, unknown>;
    key = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (key);
  return null;
}

async function main() {
  if (IDS.length === 0) throw new Error("ZAICO_IDS を指定してください(例: ZAICO_IDS=73116696,73116698)");
  const table = await inventoryTable();
  console.log(`table = ${table}`);
  console.log(APPLY ? "モード: --apply(実際に更新します)\n" : "モード: dry-run(書き込みません)\n");

  const { DynamoDBDocumentClient: _c } = await import("@aws-sdk/lib-dynamodb");
  const { UpdateCommand } = await import("@aws-sdk/lib-dynamodb");

  for (const id of IDS) {
    const zaico = await getInventory(id);
    const core = mapZaicoCoreFields(zaico);
    const opt = mapZaicoOptionalAttributes(zaico.optional_attributes, false);
    const existing = await findBySourceId(table, id);

    console.log(`===== ZAICO ${id} / ${zaico.title.slice(0, 50)}…`);
    if (!existing) {
      console.log("  BELLO側に該当なし(このスクリプトは新規作成を行いません)。");
      continue;
    }
    console.log(`  BELLO: ${existing.sku} (${existing.id})`);

    // 更新したい値(新旧を並べて出す)。
    const updates: Record<string, unknown> = {};
    const show = (label: string, before: unknown, after: unknown) => {
      const changed = JSON.stringify(before ?? null) !== JSON.stringify(after ?? null);
      console.log(`   ${changed ? "→" : " "} ${label.padEnd(22)} ${JSON.stringify(before ?? null)}  ${changed ? "⇒ " + JSON.stringify(after) : ""}`);
      return changed;
    };

    if (core.fields.quantity !== null && show("quantity", existing.quantity, core.fields.quantity)) {
      updates.quantity = core.fields.quantity;
    }
    for (const [key, value] of Object.entries(opt.extendedFields)) {
      if (value === null || value === undefined) continue;
      if (show(key, existing[key], value)) updates[key] = value;
    }
    for (const [key, value] of Object.entries(opt.coreFields)) {
      if (value === undefined) continue;
      if (show(key, existing[key], value)) updates[key] = value;
    }
    if (Object.keys(opt.customFields).length > 0) {
      const before = typeof existing.customFields === "string" ? JSON.parse(existing.customFields || "{}") : {};
      const merged = { ...before, ...opt.customFields };
      if (show("customFields", before, merged)) updates.customFields = JSON.stringify(merged);
    }
    for (const w of [...core.warnings, ...opt.warnings]) console.log(`   ! ${w}`);
    for (const u of opt.unmapped) if (u.value?.trim()) console.log(`   ? 未マッピング: ${u.name}`);

    if (Object.keys(updates).length === 0) {
      console.log("  変更なし。\n");
      continue;
    }
    if (!APPLY) {
      console.log(`  (dry-run: ${Object.keys(updates).length}項目を更新する内容です)\n`);
      continue;
    }

    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const sets: string[] = [];
    let i = 0;
    for (const [k, v] of Object.entries(updates)) {
      const n = `#f${i}`;
      const p = `:v${i}`;
      names[n] = k;
      values[p] = v;
      sets.push(`${n} = ${p}`);
      i++;
    }
    names["#u"] = "updatedAt";
    values[":u"] = new Date().toISOString();
    sets.push("#u = :u");
    names["#ub"] = "updatedBy";
    values[":ub"] = "ZAICO同期(マッピング修正の実データ検証)";
    sets.push("#ub = :ub");

    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: { id: existing.id as string },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
    console.log(`  ✓ ${Object.keys(updates).length}項目を更新しました。\n`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
