/**
 * ZAICO → BELLO 全項目 漏れ監査（2026-09-02 追加仕様 §12/§15/§16）。
 *
 * ZAICOのraw responseを実際に取得し、
 *   - core field の出現率
 *   - optional_attributes の name ごとの出現率・値の例・BELLOでの対応先
 * を機械的に集計する。読み取り専用（ZAICOクライアントはGET専用）。
 *
 *   AWS_PROFILE=Bello node scripts/with-server-only-stub.cjs scripts/audit-zaico-fields.ts
 *
 * 環境変数:
 *   ZAICO_AUDIT_PAGES  取得ページ数（既定1 = 先頭1,000件）
 *   ZAICO_AUDIT_JSON   集計結果をJSONで書き出すパス
 */
import { listInventories, type ZaicoInventory } from "@/lib/zaico/client";
import { resolveZaicoAttributeTarget, normalizeZaicoAttributeName } from "@/lib/inventory/zaicoMapping";
import { writeFileSync } from "node:fs";

const PAGES = Number(process.env.ZAICO_AUDIT_PAGES ?? "1");

interface AttrStat {
  rawNames: Set<string>;
  normalized: string;
  count: number;
  nonEmpty: number;
  samples: string[];
  target: string;
}

async function main() {
  const items: ZaicoInventory[] = [];
  for (let page = 1; page <= PAGES; page++) {
    const res = await listInventories(page, 1000);
    if (res.items.length === 0) break;
    items.push(...res.items);
    console.log(`page ${page}: ${res.items.length}件 (累計 ${items.length})`);
    if (!res.hasMore) break;
  }

  console.log(`\n=== core field 出現率 (母数 ${items.length}) ===`);
  const coreKeys = new Map<string, number>();
  for (const it of items) {
    for (const [k, v] of Object.entries(it)) {
      if (k === "optional_attributes") continue;
      const present = v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0);
      if (present) coreKeys.set(k, (coreKeys.get(k) ?? 0) + 1);
    }
  }
  for (const [k, v] of [...coreKeys.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = ((v / items.length) * 100).toFixed(1);
    console.log(`  ${String(v).padStart(5)} (${pct.padStart(5)}%)  ${k}`);
  }

  console.log(`\n=== optional_attributes 一覧 ===`);
  const stats = new Map<string, AttrStat>();
  for (const it of items) {
    for (const a of it.optional_attributes ?? []) {
      const norm = normalizeZaicoAttributeName(a.name);
      let s = stats.get(norm);
      if (!s) {
        const t = resolveZaicoAttributeTarget(a.name);
        const target =
          t.kind === "coreField" ? `Inventory.${t.field}`
          : t.kind === "extendedField" ? `Inventory.${t.field}`
          : t.kind === "customField" ? `customFields.${t.fieldKey}`
          : "— 未マッピング —";
        s = { rawNames: new Set(), normalized: norm, count: 0, nonEmpty: 0, samples: [], target };
        stats.set(norm, s);
      }
      s.rawNames.add(a.name);
      s.count++;
      if (a.value != null && a.value.trim() !== "") {
        s.nonEmpty++;
        if (s.samples.length < 3) s.samples.push(a.value.trim().slice(0, 40));
      }
    }
  }
  const sorted = [...stats.values()].sort((a, b) => b.nonEmpty - a.nonEmpty);
  for (const s of sorted) {
    const pct = ((s.nonEmpty / items.length) * 100).toFixed(1);
    console.log(`  ${String(s.nonEmpty).padStart(5)}/${String(s.count).padStart(5)} (${pct.padStart(5)}%)  ${s.normalized}`);
    console.log(`          → ${s.target}`);
    if (s.samples.length) console.log(`          例: ${s.samples.join(" | ")}`);
  }

  const unmapped = sorted.filter((s) => s.target === "— 未マッピング —" && s.nonEmpty > 0);
  console.log(`\n=== 値を持つのにBELLOへマッピングされていない項目: ${unmapped.length}件 ===`);
  for (const s of unmapped) console.log(`  ${s.normalized}  (値あり ${s.nonEmpty}件)  例: ${s.samples.join(" | ")}`);

  if (process.env.ZAICO_AUDIT_JSON) {
    writeFileSync(process.env.ZAICO_AUDIT_JSON, JSON.stringify({
      itemCount: items.length,
      coreFields: Object.fromEntries(coreKeys),
      attributes: sorted.map((s) => ({ normalized: s.normalized, rawNames: [...s.rawNames], count: s.count, nonEmpty: s.nonEmpty, samples: s.samples, target: s.target })),
    }, null, 2), "utf8");
    console.log(`\nJSON → ${process.env.ZAICO_AUDIT_JSON}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
