/**
 * ZAICO同期の「失敗が失われない」ことの回帰テスト（2026-09-07）。
 *
 * ── 何を守るテストか ────────────────────────────────────────────
 *
 * 2026-09-06 15:02:53 UTC、ZAICO同期の advance が
 * `POST /inventory/settings 500` で落ちた。落ちた事実は CloudFront の
 * アクセスログにしか残っておらず、**原因を示す情報がどこにも無かった**:
 *
 *   - Staging の SSR ログは CloudWatch へ届かない（commit d44d8e0）
 *   - Server Action が投げたので、ブラウザには本番既定の
 *     「An error occurred in the Server Components render.」だけ
 *   - ZaicoSyncJob.lastError は advanceOnePage の内側でしか書かれず、
 *     その外で投げた今回は空のまま
 *
 * さらに、この経路には「取得エラーが 0件 に化ける」箇所が残っていた。
 * 化けると失敗ではなく**間違った成功**になるので、こちらの方が重い。
 *
 * ── なぜソース検査なのか ────────────────────────────────────────
 *
 * ここで守りたいのは「呼び出し規約が守られていること」で、これは
 * 実行時の振る舞いではなくコードの形そのもの。対象の関数は
 * モジュールレベルの `serverDataClient` を直接掴んでおり差し替え口が
 * 無い（差し替え口を作るのは今回の不具合修正の範囲を超える）。
 * 同じ理由でソース検査を採っている先例が scripts/
 * verify-integrity-monitor.ts の backend.ts 突き合わせ。
 *
 * Run with: npm run verify:zaico-error-surfacing
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");

let failures = 0;
let passes = 0;

function check(condition: boolean, label: string, detail?: string) {
  if (condition) {
    passes++;
    console.log(`✓ ${label}`);
  } else {
    failures++;
    console.error(`✗ FAIL ${label}${detail ? `\n    ${detail}` : ""}`);
  }
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/** `const { data } = await serverDataClient.models.X.list(...)` のような、errors を見ない取り出し。 */
function findUncheckedUnwraps(source: string): string[] {
  const hits: string[] = [];
  const lines = source.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!/serverDataClient\.models\.[A-Za-z]+\.(list|get)\(/.test(line)) return;
    // 直前に `const { data ... } =` / `const { data: x ... } =` が付いていたら、errors を見ていない。
    if (/const\s*\{\s*data\b/.test(line)) hits.push(`${i + 1}: ${line.trim()}`);
  });
  return hits;
}

console.log("\n── 1. 取得エラーが「0件」「ジョブ無し」に化けないこと ──────────\n");

for (const rel of ["lib/inventory/zaicoSyncPorts.ts", "lib/inventory/zaicoBackgroundSync.ts"]) {
  const src = read(rel);
  const hits = findUncheckedUnwraps(src);
  check(
    hits.length === 0,
    `${rel}: list/get の結果を errors を見ずに取り出している箇所が無い`,
    hits.join("\n    "),
  );
}

{
  const src = read("lib/inventory/zaicoSyncPorts.ts");
  // ここが空の Map に化けると、syncOneZaicoItem は全商品を「BELLOに無い」と
  // 判断して新規作成へ進む。この同期経路で最も重い取り違え。
  const fn = src.slice(src.indexOf("async function serverFetchAllZaicoManaged"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  check(
    /unwrapList\(/.test(body),
    "serverFetchAllZaicoManaged が unwrapList を通している（空Map化＝重複作成を防ぐ）",
  );
}

{
  const src = read("lib/inventory/zaicoBackgroundSync.ts");
  const fn = src.slice(src.indexOf("export async function getZaicoBackgroundSyncStatus"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  check(
    /unwrapGet\(/.test(body),
    "getZaicoBackgroundSyncStatus が unwrapGet を通している（読めない＝未実行、に化けない）",
  );
}

{
  const src = read("lib/inventory/zaicoBackgroundSync.ts");
  const fn = src.slice(src.indexOf("export async function advanceZaicoBackgroundSyncJob"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  check(
    /unwrapGet\(/.test(body),
    "advanceZaicoBackgroundSyncJob が unwrapGet を通している（読めない＝進めるものが無い、に化けない）",
  );
}

console.log("\n── 2. 失敗がジョブ行に残ること ────────────────────────────────\n");

{
  const src = read("lib/inventory/zaicoBackgroundSync.ts");
  check(
    /export async function recordZaicoSyncJobError\(/.test(src),
    "recordZaicoSyncJobError が存在する（SSRログが無い環境で唯一残せる痕跡）",
  );

  const fn = src.slice(src.indexOf("export async function recordZaicoSyncJobError"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  check(/lastError:/.test(body), "recordZaicoSyncJobError が lastError を書く");
  // status を変えると zaico-sync-worker Lambda（PENDING/RUNNING だけ引き継ぐ）が
  // ジョブを見捨てる。実際 2026-09-06 の失敗は、status が PENDING のまま
  // 残っていたおかげで3分後のLambdaが最後まで完了させている。
  check(
    !/status:/.test(body),
    "recordZaicoSyncJobError が status を変えない（Lambdaによる引き継ぎを壊さない）",
  );
  check(
    /catch\s*\(/.test(body),
    "recordZaicoSyncJobError 自身の失敗で呼び出し元のメッセージを失わない",
  );
}

console.log("\n── 3. Server Action が素の例外をブラウザへ返さないこと ────────\n");

{
  const src = read("app/actions/zaicoSync.ts");
  check(
    /async function withReportedFailure</.test(src),
    "withReportedFailure が存在する",
  );

  const wrapped = [
    "startZaicoBackgroundSyncAction",
    "advanceZaicoBackgroundSyncAction",
    "cancelZaicoBackgroundSyncAction",
    "getZaicoBackgroundSyncStatusAction",
  ];
  for (const name of wrapped) {
    const at = src.indexOf(`export async function ${name}`);
    const body = src.slice(at, src.indexOf("\n}", at));
    check(
      /withReportedFailure/.test(body),
      `${name} が withReportedFailure で包まれている`,
    );
  }

  const fn = src.slice(src.indexOf("async function withReportedFailure"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  check(/recordZaicoSyncJobError\(/.test(body), "withReportedFailure がジョブ行へも記録する");
  check(/onFailure\(message\)/.test(body), "withReportedFailure が理由を戻り値で返す");
}

console.log("\n── 4. 画面が理由を表示すること ────────────────────────────────\n");

{
  const src = read("app/inventory/(protected)/settings/ZaicoSyncPanel.tsx");
  const at = src.indexOf("async function runAdvance");
  const body = src.slice(at, src.indexOf("\n  }", at));
  check(/reason/.test(body), "runAdvance が reason を受け取る");
  check(/setBgError\(/.test(body), "runAdvance が reason を画面へ出す");
  // ここが残らないと、利用者は「エラーが出た＝同期が失われた」と読む。
  check(
    /自動実行が引き継/.test(body),
    "画面からの続行を止めても、ジョブがLambdaに引き継がれることを伝える",
  );
}

console.log(`\n${passes} passed, ${failures} failed\n`);
if (failures > 0) process.exit(1);
