/**
 * BELLO 性能総点検 — Staging の HTTP 応答時間(2026-09-04)。
 *
 *   npm run measure:staging-http
 *
 * ── 何が測れて、何が測れないか ──────────────────────────────────
 *
 * ログイン済みの画面はブラウザのセッションが要る(この環境には
 * Staging の資格情報が登録されていない)。そこで**認証を必要としない
 * 範囲**で、SSR そのものの速さを測る:
 *
 *   ・ログイン画面(SSRあり、DBアクセスなし)     → SSRの素の速さ
 *   ・保護ルート(未ログイン→ログインへリダイレクト) → 認証判定の時間
 *   ・静的アセット(JS/CSS)                      → 配信の速さと大きさ
 *
 * 保護ルートのリダイレクトは、`getInventorySessionStatus`(Cognitoの
 * セッション確認)を通ってから返る。つまり**認証判定だけの時間**が
 * ここに出る —— 画面本体のDBアクセスが乗る前の下駄がいくらか分かる。
 *
 * ── 冷えている場合と温まっている場合を分ける ────────────────────
 *
 * Amplify の SSR は Lambda で動く。しばらく叩かれていないと起動から
 * 始まる(コールドスタート)。1回目と、続けて叩いた2回目以降を別々に
 * 出す —— 平均だけを見ると、どちらの問題なのか分からなくなる。
 */

// import が1つも無いファイルを TypeScript は**モジュールではなくスクリプト**
// (グローバルスコープ)として扱う。すると `main` のような素朴な名前が、
// 同じくグローバルな別スクリプトの同名関数と衝突して型検査が落ちる
// (実際に scripts/benchmark-inventory-queries.ts の main と衝突した)。
// この1行でモジュールになり、以降の宣言はこのファイルの中だけのものになる。
export {};

const ORIGIN = "https://claude-inventory-management-system-5vbvc7.d4hkkg7dty2du.amplifyapp.com";

interface Sample {
  label: string;
  path: string;
  status: number;
  /** 最初のバイトまで(ms)。 */
  ttfbMs: number;
  /** 本文を読み終わるまで(ms)。 */
  totalMs: number;
  bytes: number;
  note: string;
}

async function hit(label: string, path: string): Promise<Sample> {
  const started = performance.now();
  const res = await fetch(`${ORIGIN}${path}`, { redirect: "manual", headers: { "User-Agent": "bello-perf-check" } });
  const ttfbMs = performance.now() - started;
  const body = await res.text();
  const totalMs = performance.now() - started;
  const location = res.headers.get("location");
  return {
    label,
    path,
    status: res.status,
    ttfbMs: Math.round(ttfbMs),
    totalMs: Math.round(totalMs),
    bytes: body.length,
    note: location ? `→ ${location}` : (res.headers.get("x-amz-cf-pop") ?? ""),
  };
}

const TARGETS: { label: string; path: string }[] = [
  { label: "ログイン画面(SSR、DBなし)", path: "/inventory/login" },
  { label: "在庫一覧(未ログイン→リダイレクト)", path: "/inventory" },
  { label: "商品詳細(未ログイン→リダイレクト)", path: "/inventory/dummy-id" },
  { label: "メッセージ(未ログイン→リダイレクト)", path: "/inventory/messages" },
  { label: "設定(未ログイン→リダイレクト)", path: "/inventory/settings" },
  { label: "売上(未ログイン→リダイレクト)", path: "/inventory/sales" },
];

function report(title: string, samples: Sample[]): void {
  console.log(`\n${title}`);
  for (const s of samples) {
    console.log(
      `  TTFB ${String(s.ttfbMs).padStart(5)}ms  合計 ${String(s.totalMs).padStart(5)}ms  ` +
        `HTTP ${s.status}  ${(s.bytes / 1024).toFixed(0).padStart(4)}KB  ${s.label}${s.note ? `  ${s.note}` : ""}`,
    );
  }
}

async function main() {
  console.log(`[measure-staging-http] ${new Date().toISOString()}`);
  console.log(`  対象: ${ORIGIN}`);

  // 1回目。しばらく叩かれていなければコールドスタートを含む。
  const cold: Sample[] = [];
  for (const t of TARGETS) cold.push(await hit(t.label, t.path));
  report("■ 1回目(コールドスタートを含みうる)", cold);

  // 2回目以降。温まった状態。
  const warm: Sample[] = [];
  for (const t of TARGETS) {
    const runs: Sample[] = [];
    for (let i = 0; i < 3; i++) runs.push(await hit(t.label, t.path));
    // 中央値を代表にする。
    runs.sort((a, b) => a.ttfbMs - b.ttfbMs);
    warm.push(runs[1]);
  }
  report("■ 温まった状態(3回の中央値)", warm);

  console.log("\n■ 冷/温の差");
  for (let i = 0; i < TARGETS.length; i++) {
    const diff = cold[i].ttfbMs - warm[i].ttfbMs;
    console.log(
      `  ${String(diff > 0 ? `+${diff}` : diff).padStart(6)}ms  ${TARGETS[i].label} ` +
        `(1回目 ${cold[i].ttfbMs}ms → 温 ${warm[i].ttfbMs}ms)`,
    );
  }

  console.log("\n※ 保護ルートは未ログインのためリダイレクトで返っています。");
  console.log("  つまりここに出るのは「SSRの起動 + 認証判定」までで、画面本体のDBアクセスは含みません。");
  console.log("  ログイン済みの画面の実測には Staging の資格情報が要ります(この環境には未登録)。");
}

void main().catch((err) => {
  console.error(`[measure-staging-http] 失敗: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
