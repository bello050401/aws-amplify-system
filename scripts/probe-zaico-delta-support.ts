/**
 * ZAICO API が「最終更新日時以降だけ返す」条件指定に対応しているかを
 * **実際に叩いて**確かめる調査スクリプト。
 *
 * ── なぜ必要か ──────────────────────────────────────────────────
 *
 * 差分同期をやるなら、
 *
 *   案A: ZAICO側で絞って取る（速い。転送も処理も減る）
 *   案B: 全件取ってBELLO側で updated_at を比較する（取得は速くならない）
 *
 * のどちらになるかで設計が変わる。指示は「API仕様を推測せず、実際の
 * レスポンスで判断すること」。ここはその確認だけを行い、**同期は一切
 * 実行しない**（読み取りのみ）。
 *
 * ── 判定方法 ────────────────────────────────────────────────────
 *
 * 未知のクエリパラメータを無視するAPIは多い。「パラメータを付けたら
 * 200が返った」だけでは対応の証拠にならない。
 *
 *   1. 素の1ページ目を取る（基準）
 *   2. 各候補パラメータを付けて取る
 *   3. **件数と先頭IDが基準と変わったか**で判定する
 *      変わらなければ「無視された」= 非対応
 *
 * さらに、明らかに未来の日時を渡して0件に近づくかも見る。効いているなら
 * 件数は激減するはず。
 *
 * Run with: npm run probe:zaico-delta
 */
import { getZaicoApiToken } from "@/lib/zaico/client";

const BASE_URL = "https://web.zaico.co.jp/api/v1";

interface Probe {
  label: string;
  params: Record<string, string>;
}

/** ZAICOのAPIドキュメントに載っていない可能性のある名前も含め、広めに試す。 */
function buildProbes(sinceIso: string, futureIso: string): Probe[] {
  const names = [
    "updated_at_since",
    "updated_since",
    "since",
    "updated_at_gteq",
    "updated_at_from",
    "from",
    "modified_since",
    "q[updated_at_gteq]",
  ];
  const probes: Probe[] = [];
  for (const n of names) {
    probes.push({ label: `${n}=<過去>`, params: { [n]: sinceIso } });
  }
  // 未来日時。効いていれば0件に近づくはず。
  probes.push({ label: "updated_at_since=<未来>", params: { updated_at_since: futureIso } });
  probes.push({ label: "since=<未来>", params: { since: futureIso } });
  return probes;
}

async function fetchPage(
  token: string,
  params: Record<string, string>,
): Promise<{ status: number; count: number; firstId: number | null; note: string }> {
  const url = new URL(`${BASE_URL}/inventories`);
  url.searchParams.set("page", "1");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    return { status: res.status, count: -1, firstId: null, note: text.slice(0, 120) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: res.status, count: -1, firstId: null, note: "JSONとして読めない" };
  }
  if (!Array.isArray(parsed)) {
    return { status: res.status, count: -1, firstId: null, note: "配列ではない: " + text.slice(0, 80) };
  }
  const arr = parsed as { id?: number; updated_at?: string | null }[];
  return { status: res.status, count: arr.length, firstId: arr[0]?.id ?? null, note: "" };
}

async function main() {
  const token = await getZaicoApiToken();

  // 1) 基準
  const base = await fetchPage(token, {});
  console.log("=== 基準（パラメータなし・page=1） ===");
  console.log(`  status=${base.status} 件数=${base.count} 先頭id=${base.firstId}`);
  if (base.count <= 0) {
    console.log("  基準が取れないので判定できません。");
    process.exit(1);
  }

  // updated_at が実際に入っているかも確認する（BELLO側比較の可否）。
  const sample = await fetch(`${BASE_URL}/inventories?page=1`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  })
    .then((r) => r.json())
    .catch(() => null);
  if (Array.isArray(sample) && sample.length > 0) {
    const withUpdated = sample.filter((x: { updated_at?: string | null }) => Boolean(x.updated_at)).length;
    console.log(`  updated_at を持つ件数: ${withUpdated} / ${sample.length}`);
    const first = sample[0] as { updated_at?: string | null; created_at?: string | null };
    console.log(`  例: updated_at=${first.updated_at ?? "なし"} created_at=${first.created_at ?? "なし"}`);
  }

  const now = Date.now();
  const sinceIso = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
  const futureIso = new Date(now + 365 * 24 * 3600 * 1000).toISOString();

  console.log("");
  console.log("=== 差分パラメータの候補を実際に試す ===");
  console.log(`  過去日時: ${sinceIso}`);
  console.log(`  未来日時: ${futureIso}`);
  console.log("");

  let supported: string | null = null;
  for (const p of buildProbes(sinceIso, futureIso)) {
    const r = await fetchPage(token, p.params);
    const changed = r.count !== base.count || r.firstId !== base.firstId;
    const verdict =
      r.count < 0
        ? `エラー(${r.status}) ${r.note}`
        : changed
          ? "★ 応答が変わった（効いている可能性）"
          : "変化なし（無視された）";
    console.log(`  ${p.label.padEnd(28)} status=${r.status} 件数=${String(r.count).padStart(5)} 先頭id=${String(r.firstId ?? "-").padStart(10)}  ${verdict}`);
    if (changed && r.count >= 0 && p.label.includes("未来") && r.count < base.count) {
      supported = Object.keys(p.params)[0];
    }
    // ZAICO側のレート制限に配慮して間隔を空ける。
    await new Promise((r2) => setTimeout(r2, 1200));
  }

  console.log("");
  console.log("=== 判定 ===");
  if (supported) {
    console.log(`  サーバー側の差分取得に対応している可能性: パラメータ "${supported}"`);
    console.log("  ただし、未来日時で件数が減ったことを根拠にしているだけなので、");
    console.log("  実装前に「過去日時での件数が妥当か」も併せて確認すること。");
  } else {
    console.log("  どの候補も応答を変えませんでした。");
    console.log("  → **ZAICO API側での差分取得は使えない**と判断する。");
    console.log("  → 差分同期は「全件取得 + BELLO側で updated_at 比較」で組む必要がある。");
    console.log("     (取得の往復は減らせないが、CREATE/UPDATEの書き込みと");
    console.log("      画像処理・履歴記録を差分だけに絞れるので処理時間は縮む)");
  }
}

void main();
