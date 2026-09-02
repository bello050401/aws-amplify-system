/**
 * 差分同期でどれだけ処理を省けるかを、**実データで**測る。
 *
 * ZAICOの全在庫を1回だけ読み（読み取りのみ・同期はしない）、
 * 「最終更新日時がいつか」の分布を出す。差分同期にしたとき、通常運用で
 * 何件が処理対象になるのかが数字で分かる。
 *
 * Run with: npm run measure:zaico-delta
 */
import { listInventories } from "@/lib/zaico/client";
import { needsSync, resolveDeltaSince } from "@/lib/inventory/zaicoDelta";

async function main() {
  const started = Date.now();
  const all: { id: number; updated_at?: string | null; created_at?: string | null }[] = [];

  let page = 1;
  for (;;) {
    const { items, hasMore } = await listInventories(page, 1000);
    all.push(...items);
    process.stdout.write(`\r  取得中… ${all.length}件（${page}ページ）`);
    if (!hasMore) break;
    page++;
    if (page > 50) break; // 安全弁
  }
  const fetchMs = Date.now() - started;
  console.log(`\n  取得完了: ${all.length}件 / ${page}ページ / ${(fetchMs / 1000).toFixed(1)}秒\n`);

  const withUpdated = all.filter((x) => x.updated_at).length;
  console.log(`  updated_at を持つ: ${withUpdated} / ${all.length}`);

  const now = Date.now();
  const windows: [string, number][] = [
    ["1時間", 1 / 24],
    ["1日", 1],
    ["3日", 3],
    ["7日", 7],
    ["30日", 30],
    ["90日", 90],
    ["365日", 365],
  ];

  console.log("");
  console.log("  「前回同期がこの期間前だった場合、今回処理する件数」");
  console.log("  ─────────────────────────────────────────────");
  for (const [label, days] of windows) {
    const last = new Date(now - days * 24 * 3600 * 1000).toISOString();
    const since = resolveDeltaSince(last);
    const target = all.filter((x) => needsSync(x, since)).length;
    const pct = ((target / all.length) * 100).toFixed(1);
    const bar = "█".repeat(Math.max(0, Math.round((target / all.length) * 40)));
    console.log(`  ${label.padStart(6)}前  ${String(target).padStart(5)}件 (${pct.padStart(5)}%)  ${bar}`);
  }

  // 最も古い/新しい更新日時。
  const stamps = all
    .map((x) => x.updated_at ?? x.created_at)
    .filter((v): v is string => Boolean(v))
    .map((v) => new Date(v).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (stamps.length > 0) {
    console.log("");
    console.log(`  最も古い更新: ${new Date(stamps[0]).toISOString()}`);
    console.log(`  最も新しい更新: ${new Date(stamps[stamps.length - 1]).toISOString()}`);
    const median = new Date(stamps[Math.floor(stamps.length / 2)]).toISOString();
    console.log(`  中央値        : ${median}`);
  }

  console.log("");
  console.log("  ※ 取得の往復は差分同期でも減らない（ZAICO APIが条件指定に非対応）。");
  console.log("     減るのは上の「処理する件数」＝照合・マージ・書き込み・画像・履歴。");
}

void main();
