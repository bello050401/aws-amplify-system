/**
 * 3-wayマージの基準(zaicoSnapshotJson)が固着した在庫を修復する。
 *
 * ── 何が起きていたか ────────────────────────────────────────────
 *
 * 据え置いた回にも基準をZAICOの現在値へ進めていたため、BELLOの値は
 * 二度と基準と一致せず、その項目が**永久に「人が編集した」と判定され**
 * ZAICOの変更が入らなくなっていた(詳細は lib/inventory/zaicoSyncMerge.ts)。
 *
 * コード側は修正済みだが、**既に壊れた基準は自動では直らない**。
 * 基準がZAICOの現在値のままなので、次の同期でもやはり一致しない。
 *
 * ── 直し方 ──────────────────────────────────────────────────────
 *
 * 基準をBELLOの現在値へ置き直す。こうすると次の同期で
 * 「BELLOの値 == 基準 = 人は触っていない」と正しく判定され、ZAICOの値が入る。
 *
 * ── 人の編集を巻き込まないための条件 ────────────────────────────
 *
 * **人が「カテゴリを実際に変更した」履歴がある在庫は対象外にする。**
 * 人がBELLOで直した値を、この修復でZAICOへ戻してしまってはいけない。
 *
 * 判定は「ZAICO同期以外の履歴があるか」では粗すぎる。実測(2026-09-03)で、
 * 在庫72179017 には人による履歴が2件あったが、どちらも**変更項目が0件**
 * (画像操作などフィールド差分を伴わない更新)で、カテゴリには触れていな
 * かった。それだけで修復対象から外すと、直せるものが直らない。
 * 履歴の中身を見て、カテゴリを変更したものだけを人の編集として扱う。
 *
 * ── 実行 ────────────────────────────────────────────────────────
 *
 *   AWS_PROFILE=Bello CONVERSATION_TABLE_NAME=... \
 *     npm run repair:zaico-snapshot-latch          # 確認のみ(既定)
 *   ... npm run repair:zaico-snapshot-latch -- --apply   # 実際に書き込む
 */
import { runWithDirectData, serverDataClient as c } from "@/lib/amplify/dataClient";

const APPLY = process.argv.includes("--apply");
/** 修復対象の項目。業務ステータスであるカテゴリに限定する。 */
const TARGET_FIELD = "categoryId";
const ZAICO_SYNC_MARKER = "ZAICO同期";

interface Row {
  id: string;
  sourceInventoryId?: string | null;
  categoryId?: string | null;
  zaicoSnapshotJson?: string | null;
}

async function main() {
  await runWithDirectData(async () => {
    const { data: cats } = await c.models.Category.list({ limit: 500 });
    const cname = (id: unknown) =>
      ((cats ?? []) as unknown as { id: string; name?: string | null }[]).find((x) => x.id === id)?.name ?? String(id ?? "-");

    const { data } = await c.models.Inventory.list({ limit: 5000 });
    const all = (data ?? []) as unknown as Row[];

    const latched: { row: Row; snapshot: Record<string, unknown> }[] = [];
    for (const row of all) {
      if (!row.zaicoSnapshotJson) continue;
      let snap: Record<string, unknown>;
      try {
        snap = JSON.parse(row.zaicoSnapshotJson) as Record<string, unknown>;
      } catch {
        continue;
      }
      const base = snap[TARGET_FIELD];
      if (base === undefined) continue;
      if ((base ?? null) !== (row.categoryId ?? null)) latched.push({ row, snapshot: snap });
    }

    console.log(`在庫 ${all.length}件 / 基準が固着している在庫 ${latched.length}件`);
    console.log(APPLY ? "モード: 書き込み(--apply)" : "モード: 確認のみ(書き込まない)");

    let repaired = 0;
    let skippedHuman = 0;
    let failed = 0;

    for (const { row, snapshot } of latched) {
      // 人の編集が1度でもあれば触らない。
      const { data: hist } = await c.models.InventoryHistory.listInventoryHistoryByInventoryIdAndChangedAt(
        { inventoryId: row.id },
        { limit: 200 },
      );
      const humanWrites = ((hist ?? []) as unknown as { changedBy?: string | null; changes?: unknown }[])
        .filter((h) => !String(h.changedBy ?? "").includes(ZAICO_SYNC_MARKER))
        .filter((h) => {
          // 中身を見て、カテゴリを触った履歴だけを人の編集として扱う。
          let changes: unknown = h.changes;
          if (typeof changes === "string") {
            try {
              changes = JSON.parse(changes);
            } catch {
              // 読めない履歴は「触ったかもしれない」として安全側に倒す。
              return true;
            }
          }
          if (!Array.isArray(changes)) return false;
          return changes.some((x) => /カテゴリ/.test(String((x as { fieldName?: unknown })?.fieldName ?? "")));
        });
      const label = `${row.sourceInventoryId ?? row.id}  BELLO=${cname(row.categoryId)} / 基準=${cname(snapshot[TARGET_FIELD])}`;
      if (humanWrites.length > 0) {
        skippedHuman++;
        console.log(`  対象外 ${label}  (人がカテゴリを変更した履歴 ${humanWrites.length}件)`);
        continue;
      }

      if (!APPLY) {
        repaired++;
        console.log(`  修復予定 ${label}`);
        continue;
      }

      const next = { ...snapshot, [TARGET_FIELD]: row.categoryId ?? undefined };
      if (next[TARGET_FIELD] === undefined) delete next[TARGET_FIELD];
      const res = await c.models.Inventory.update({ id: row.id, zaicoSnapshotJson: JSON.stringify(next) });
      if (res.errors && res.errors.length > 0) {
        failed++;
        console.log(`  失敗 ${label}: ${res.errors.map((e) => e.message).join("; ")}`);
        continue;
      }
      repaired++;
      console.log(`  修復 ${label}`);
    }

    console.log(
      `\n${APPLY ? "修復" : "修復予定"} ${repaired}件 / 人の編集があるため対象外 ${skippedHuman}件 / 失敗 ${failed}件`,
    );
    if (!APPLY) console.log("実際に書き込むには --apply を付けて再実行してください。");
    console.log("修復後、次のZAICO同期でZAICO側のカテゴリが反映されます。");
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
