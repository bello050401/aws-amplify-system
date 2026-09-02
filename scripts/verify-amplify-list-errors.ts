/**
 * Amplify の list系呼び出しで「エラーを0件と混同しない」ことの検証。
 *
 * ── なぜこの検証が要るのか ──────────────────────────────────────
 *
 * @aws-amplify/data-schema の handleListGraphQlError は、GraphQLエラーの
 * とき **`data: []` を返す**(ネットワーク等のエラーだけを再throwする)。
 * つまり `errors` を見ない限り、認可拒否・indexの不在・スロットリングは
 * 呼び出し側から「該当0件」と区別が付かない。
 *
 * とくに危ないのは、0件が**開く方向**へ倒れる判定:
 *
 *   重複を防ぐ判定  … 「既にあるか」が空 → もう1件作る
 *   削除の可否判定  … 「使われているか」が0 → 使用中でも消す
 *
 * ここでは unwrapList/unwrapGet の挙動と、上記の判定箇所が実際に
 * それを通していることを静的に確かめる。AWSにもブラウザにも繋がない。
 *
 * Run with: npm run verify:amplify-list-errors
 */
import fs from "node:fs";
import path from "node:path";
import { unwrapList, unwrapGet } from "@/lib/amplify/listAll";

let failures = 0;
let passes = 0;
function assertEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ FAIL ${label}\n    expected: ${e}\n    actual:   ${a}`);
  } else {
    passes++;
    console.log(`✓ ${label}`);
  }
}
function assertTrue(cond: boolean, label: string) {
  assertEqual(cond, true, label);
}
function assertThrows(fn: () => unknown, label: string): string {
  try {
    fn();
  } catch (err) {
    passes++;
    console.log(`✓ ${label}`);
    return err instanceof Error ? err.message : String(err);
  }
  failures++;
  console.error(`✗ FAIL ${label}\n    expected: 例外, actual: 正常終了`);
  return "";
}

const repoRoot = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

/* ══════════════════════════════════════════════════════════════════
 * 1. unwrapList / unwrapGet の挙動
 * ══════════════════════════════════════════════════════════════════ */
function testUnwrap() {
  assertEqual(unwrapList({ data: [1, 2, 3] }, "テスト"), [1, 2, 3], "unwrapList: errors無しはそのまま返す");
  assertEqual(unwrapList({ data: [] }, "テスト"), [], "unwrapList: 本当に0件なら空配列を返す");
  assertEqual(unwrapList({ data: [1], errors: [] }, "テスト"), [1], "unwrapList: errorsが空配列なら成功扱い");

  const msg = assertThrows(
    () => unwrapList({ data: [], errors: [{ message: "Not Authorized" }] }, "出品下書き"),
    "unwrapList: errorsがあれば投げる(0件と混同しない)",
  );
  assertTrue(msg.includes("出品下書き"), "unwrapList: 何の取得に失敗したかを名指しする");
  assertTrue(msg.includes("Not Authorized"), "unwrapList: 元のエラー文言を捨てない");

  const multi = assertThrows(
    () => unwrapList({ data: [], errors: [{ message: "A" }, { message: "B" }] }, "テスト"),
    "unwrapList: 複数エラーでも投げる",
  );
  assertTrue(multi.includes("A") && multi.includes("B"), "unwrapList: 複数エラーをすべて出す");

  // errors があるのに data が空でない、という組み合わせでも通さない。
  assertThrows(
    () => unwrapList({ data: [1, 2], errors: [{ message: "partial failure" }] }, "テスト"),
    "unwrapList: 部分的な結果でもerrorsがあれば投げる",
  );

  assertEqual(unwrapGet({ data: { id: "x" } }, "テスト"), { id: "x" }, "unwrapGet: 見つかればそのまま返す");
  assertEqual(unwrapGet({ data: null }, "テスト"), null, "unwrapGet: 見つからないのは正常(nullを返す)");
  assertThrows(
    () => unwrapGet({ data: null, errors: [{ message: "boom" }] }, "テスト"),
    "unwrapGet: errorsがあれば投げる(見つからないと混同しない)",
  );
}

/* ══════════════════════════════════════════════════════════════════
 * 2. Amplifyランタイムの前提が変わっていないか
 * ══════════════════════════════════════════════════════════════════
 * この検証の存在理由そのものが「GraphQLエラーが data:[] になる」こと。
 * 依存を上げた拍子にこれが変われば、前提を書き直す必要がある。
 */
function testRuntimeAssumption() {
  const rel = "node_modules/@aws-amplify/data-schema/dist/cjs/runtime/internals/operations/utils.js";
  const full = path.join(repoRoot, rel);
  if (!fs.existsSync(full)) {
    console.log(`⚠ スキップ: ${rel} が無い(依存の構成が変わった可能性)`);
    return;
  }
  const src = fs.readFileSync(full, "utf8");
  const fn = src.slice(src.indexOf("function handleListGraphQlError"));
  const body = fn.slice(0, fn.indexOf("function handleSingularGraphQlError"));
  assertTrue(body.includes("data: []"), "前提: list系のGraphQLエラーは data:[] になる(だからerrorsを見る必要がある)");
  assertTrue(body.includes("throw error"), "前提: GraphQL以外のエラーは再throwされる");
}

/* ══════════════════════════════════════════════════════════════════
 * 3. 0件が「開く方向」へ倒れる判定が、実際に通してあるか
 * ══════════════════════════════════════════════════════════════════ */
interface GuardSite {
  file: string;
  /**
   * 0件だと壊れる**判定そのもの**を指す文字列。取得側ではなく判定側に
   * 錨を打つ —— 判定が別の関数へ動いても、動いた先で unwrapList を通して
   * いなければ落ちる。同じ文字列が複数行にあれば、そのすべてを見る。
   */
  decisions: string[];
  why: string;
}

const GUARD_SITES: GuardSite[] = [
  {
    file: "lib/inventory/masters.ts",
    // 件数を積む行そのものに錨を打つ。取得と加算が別行なので、取得側へ
    // 打つと「直前12行」の窓から外れる。
    decisions: ["total +="],
    why: "マスタ削除の可否: 0件だと使用中でも消える",
  },
  {
    file: "lib/messaging/service.ts",
    decisions: ["if (existingMessages.length > 0) return { deduped: true };", "let conversation = existingConversations[0] ?? null;"],
    why: "Webhookのidempotency: 0件だと同じメッセージ/会話をもう1件作る",
  },
  {
    file: "lib/listing/service.ts",
    decisions: ["const found = data.find((d) => !d.deletedAt);", "const found = data.find((d) => d.channel === channel);"],
    why: "出品下書き/チャネル出品: 0件だと2件目ができる",
  },
  {
    file: "lib/inventory/customFieldSeed.ts",
    decisions: ["const existingKeys = new Set(existing.map((f) => f.fieldKey));"],
    why: "追加項目のseed: 0件だと同一fieldKeyで再seedする",
  },
  {
    file: "app/actions/imageProcessing.ts",
    decisions: ["const nextVersion = existing.length > 0", "if (p.active && p.id !== id)"],
    why: "Photo Profile: 0件だと版番号が衝突しACTIVEが2つ残る",
  },
];

function testGuardSites() {
  for (const site of GUARD_SITES) {
    const lines = read(site.file).split(/\r?\n/);
    for (const decision of site.decisions) {
      const at = lines
        .map((l, i) => (l.includes(decision) ? i : -1))
        .filter((i) => i >= 0);
      if (at.length === 0) {
        failures++;
        console.error(`✗ FAIL 判定が見つからない: ${site.file} の "${decision}"(実装が動いた可能性)`);
        continue;
      }
      for (const idx of at) {
        // 判定の直前12行のどこかで unwrapList を通していること。
        const window = lines.slice(Math.max(0, idx - 12), idx + 1).join("\n");
        assertTrue(window.includes("unwrapList"), `${site.file}:${idx + 1} ${site.why}`);
      }
    }
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 4. まだ errors を見ていない list系がどれだけ残っているか
 * ══════════════════════════════════════════════════════════════════
 * ここは**落とさない**。全部直すのは別の作業で、いま落とすと
 * 「残りを直すまでCIが赤」になる。件数だけを可視化して、増えたら
 * 気づけるようにする。
 */
function reportRemaining() {
  const files: string[] = [];
  for (const r of ["lib", "app"]) {
    (function walk(d: string) {
      for (const e of fs.readdirSync(path.join(repoRoot, d), { withFileTypes: true })) {
        const rel = `${d}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(e.name)) files.push(rel);
      }
    })(r);
  }

  let total = 0;
  let handled = 0;
  for (const f of files) {
    const lines = read(f).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!/serverDataClient\.models\.\w+\.list\w*\(/.test(lines[i])) continue;
      total++;
      const ctx = lines.slice(Math.max(0, i - 8), i + 4).join("\n");
      if (ctx.includes("errors") || ctx.includes("listAllPages") || ctx.includes("unwrapList")) handled++;
    }
  }
  console.log("");
  console.log(`   list系の呼び出し           : ${total} 箇所`);
  console.log(`   errorsを見ている           : ${handled} 箇所`);
  console.log(`   まだ0件と混同しうる        : ${total - handled} 箇所`);
  console.log("   （0件が「開く方向」へ倒れる判定は上の3で個別に固定してある）");
}

testUnwrap();
testRuntimeAssumption();
testGuardSites();
reportRemaining();

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
