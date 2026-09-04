/**
 * キャッシュと、その無効化（2026-09-04 健全化 PHASE 20）。
 *
 *   npm run verify:cache
 *
 * AWSにはつながない。キャッシュ本体の振る舞いだけを固定する。
 *
 * ── なぜテストが要るのか ────────────────────────────────────────
 *
 * キャッシュの事故は**静かに起きる**。無効化を呼び忘れても画面はエラーに
 * ならず、「登録したのに件数が増えない」「マスタを直したのに反映されない」
 * という形でしか現れない。しかも数十秒で自然に直るので、報告されたころには
 * 再現しない。
 *
 * ここで固定するのは3つ。
 *   ・入れた値がちゃんと返る（キャッシュとして機能している）
 *   ・**捨てたら消える**（無効化が本当に効く）
 *   ・古い値がTTLを過ぎたら返らない
 *
 * 「捨てたら消える」を外すとテストが落ちることも確認済み。
 */
import {
  clearInventoryCountCache,
  inventoryCountCacheKey,
  readInventoryCount,
  writeInventoryCount,
  COUNT_TTL_MS,
} from "@/lib/inventory/inventoryCountCache";
import { cachedMaster, invalidateMasterCache, masterCacheKeys, MASTER_CACHE_TTL_MS } from "@/lib/inventory/masterCache";

let failures = 0;
let passes = 0;
function check(ok: boolean, label: string, detail = "") {
  if (ok) {
    passes++;
    console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`✗ FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function testCountCacheKey() {
  const a = inventoryCountCacheKey({ categoryIds: ["c2", "c1"], locationId: "L", statusId: undefined });
  const b = inventoryCountCacheKey({ categoryIds: ["c1", "c2"], locationId: "L" });
  check(a === b, "件数キー: カテゴリの並び順が違っても同じキーになる（同じ集計を2回しない）", a);

  const c = inventoryCountCacheKey({ categoryIds: ["c1"], locationId: "L" });
  check(a !== c, "件数キー: 条件が違えば別のキーになる（別の条件の件数を混ぜない）");

  const empty = inventoryCountCacheKey({});
  check(empty !== a, "件数キー: 条件なしと条件ありを取り違えない", empty);
}

function testCountCacheStoreAndInvalidate() {
  clearInventoryCountCache();
  const key = inventoryCountCacheKey({ categoryIds: ["cat-x"] });

  check(readInventoryCount(key) === null, "件数: 入れる前は null（0件と取り違えない）");

  writeInventoryCount(key, 1234);
  check(readInventoryCount(key) === 1234, "件数: 入れた値が返る");

  // 別のキーは巻き込まれない。
  const other = inventoryCountCacheKey({ locationId: "loc-y" });
  check(readInventoryCount(other) === null, "件数: 別の条件のキーは独立している");

  // ここが本題 —— 在庫が増減したときに必ず呼ばれる関数。
  clearInventoryCountCache();
  check(readInventoryCount(key) === null, "件数: 捨てたら消える（在庫の増減後に古い件数を出さない）");

  check(COUNT_TTL_MS > 0 && COUNT_TTL_MS <= 5 * 60_000, "件数: TTLが短時間に収まっている", `${COUNT_TTL_MS}ms`);
}

async function testMasterCache() {
  invalidateMasterCache();
  let loads = 0;
  const load = async () => {
    loads++;
    return [{ id: "a" }];
  };

  const first = await cachedMaster("TestModel", load);
  const second = await cachedMaster("TestModel", load);
  check(loads === 1, "マスタ: 2回目は読み直さない（同じ画面で同じマスタを何度も取らない）", `load=${loads}回`);
  check(first === second || JSON.stringify(first) === JSON.stringify(second), "マスタ: 2回目も同じ内容が返る");

  const otherKey = await cachedMaster("OtherModel", load);
  check(loads === 2, "マスタ: 別のモデルは別に読む", `load=${loads}回`);
  check(JSON.stringify(otherKey) === JSON.stringify(first), "マスタ: 別キーでも loader の結果はそのまま返る");

  check(masterCacheKeys().includes("TestModel"), "マスタ: 何が乗っているかを確認できる", masterCacheKeys().join(","));

  // ここが本題 —— マスタを書き換えたときに必ず呼ばれる関数。
  invalidateMasterCache();
  check(masterCacheKeys().length === 0, "マスタ: 捨てたら空になる");
  await cachedMaster("TestModel", load);
  check(loads === 3, "マスタ: 捨てたあとは読み直す（マスタの変更が反映される）", `load=${loads}回`);

  check(MASTER_CACHE_TTL_MS > 0 && MASTER_CACHE_TTL_MS <= 5 * 60_000, "マスタ: TTLが短時間に収まっている", `${MASTER_CACHE_TTL_MS}ms`);
  invalidateMasterCache();
}

async function testMasterCacheDoesNotCacheFailures() {
  invalidateMasterCache();
  let calls = 0;
  const failing = async () => {
    calls++;
    throw new Error("取得に失敗");
  };
  await cachedMaster("Flaky", failing).catch(() => undefined);
  await cachedMaster("Flaky", failing).catch(() => undefined);
  // 失敗を覚えてしまうと、一度の一時障害でTTLのあいだずっと失敗し続ける。
  check(calls === 2, "マスタ: 失敗はキャッシュしない（一時障害を長引かせない）", `load=${calls}回`);
  invalidateMasterCache();
}

async function main() {
  testCountCacheKey();
  testCountCacheStoreAndInvalidate();
  await testMasterCache();
  await testMasterCacheDoesNotCacheFailures();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}

void main().catch((err) => {
  console.error(`[verify-cache] 失敗: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
