/**
 * QA隔離境界(2026-09-14、task_9944d38b7e24f0afea / 2026-09-15
 * task_eb959e6dc9c6ac432f統合時に読み書き両対応へ拡張)対照試験。
 *
 * lib/amplify/dataClient.tsの境界スパイ(withE2EReadBoundarySpy)が
 * 実際に「E2E fixtureモード中に読み取り系(list/get)・書き込み系
 * (create/update/delete)を問わずserverDataClientの実体へ到達した」
 * ことを検出できることを、3つの対照で示す:
 *
 *   1. 【読み取りを検出できることの確認】fixtureゲートを迂回して
 *      serverDataClient.models.ShippingRate.list()を直接呼ぶ——この
 *      スクリプトが動くプレーンNode環境にはNext.jsのリクエストスコープが
 *      無いため、実際のAppSync呼び出し自体はnext/headersのcookies()が
 *      投げて失敗するが、スパイはその呼び出しの**前**に記録するため、
 *      「実到達を試みた」事実は失敗しても残る(=e2eReadBoundaryLeaksに
 *      積まれる)。ここが0件のままだと、この対照試験自体が
 *      「何も検出していないのに常にゼロ」という偽陰性を作りかねない
 *      ——そうならないことを先に確認する。
 *
 *   2. 【書き込みを検出できることの確認】同様にfixtureゲートを迂回して
 *      serverDataClient.models.BaseOAuthToken.update()を直接呼ぶ——
 *      当初の実装(task_9944d38b7e24f0afea)はcreate/update/deleteを
 *      対象外にしていた(「write系が未デプロイのAWSスタブへ到達して
 *      失敗するのは意図した挙動」という誤った前提による)。合成
 *      (E2E fixture)実行中に実SDKへ書き込みを試みること自体を許容しない
 *      ため、この統合でcreate/update/deleteも対象に含めた——それが
 *      機能していることをここで確認する。
 *
 *   3. 【ゼロであることの確認】実際にMercari CSV画像E2E
 *      (e2e/mercari-csv-image-download.spec.ts)が単品出品編集画面
 *      (/inventory/[id]/listing)を開くたびに通る、本タスクで隔離ゲート
 *      を追加した3関数——lib/listing/pricingService.tsのgetPricingRule、
 *      lib/shipping/service.tsのgetShippingReferencePrice、
 *      lib/base/oauth.tsのisBaseConnected——をfixtureモードで呼び、
 *      例外を投げず・e2eReadBoundaryLeaksが1件も増えないことを確認する。
 *      この3関数はどれも読み取り専用で、CSV E2Eのどのspecも書き込み系
 *      アクション(saveChannelOverrideAction等)を呼ばないため、この対照は
 *      読み書き双方についてゼロであることの証明になる。
 *
 * 実行: node scripts/with-server-only-stub.cjs scripts/verify-e2e-boundary-spy.ts
 */
// このファイルはtop-level importを持たないため、`export {}`が無いと
// TypeScriptは「モジュールではなくグローバルscript」として扱う——
// その場合、同じくimport/exportを持たないscripts/benchmark-inventory-queries.ts
// の`async function main()`とグローバルscopeで衝突し、
// `npx tsc --noEmit`がTS2393(Duplicate function implementation)を
// 報告していた(2026-09-15確認)。動作は変えず、モジュール境界だけを
// 明示する。
export {};

process.env.INVENTORY_E2E_FIXTURES = "1";

let failures = 0;
let passes = 0;

function assertTrue(cond: boolean, label: string) {
  if (cond) {
    passes++;
    console.log(`✓ ${label}`);
  } else {
    failures++;
    console.error(`✗ FAIL: ${label}`);
  }
}

async function main() {
  const { e2eReadBoundaryLeaks, serverDataClient } = await import("../lib/amplify/dataClient");

  // ── 対照1: ゲートを迂回した直接呼び出しは検出される ──────────────
  e2eReadBoundaryLeaks.length = 0;
  try {
    await serverDataClient.models.ShippingRate.list({ limit: 1 } as never);
  } catch {
    // Next.jsリクエストスコープが無いプレーンNodeではcookies()が
    // 投げて失敗するのが期待値——スパイの記録はその前に完了している。
  }
  assertTrue(
    e2eReadBoundaryLeaks.some((l) => l.model === "ShippingRate" && l.op === "list"),
    "対照1: fixtureモード中にゲート無しでServerDataClient.models.ShippingRate.list()を直接呼ぶと、境界スパイが検出する(このスクリプト自身が偽陰性でないことの確認)",
  );

  // ── 対照2: 書き込み(create/update/delete)も検出される ────────────
  e2eReadBoundaryLeaks.length = 0;
  try {
    await serverDataClient.models.BaseOAuthToken.update({ id: "singleton", accessToken: "e2e-boundary-probe" } as never);
  } catch {
    // 対照1と同じ理由でNext.jsリクエストスコープ無しでは失敗するのが期待値
    // ——スパイの記録は呼び出しの前に完了している。
  }
  assertTrue(
    e2eReadBoundaryLeaks.some((l) => l.model === "BaseOAuthToken" && l.op === "update"),
    "対照2: fixtureモード中にゲート無しでServerDataClient.models.BaseOAuthToken.update()を直接呼ぶと、境界スパイが検出する(write系も対象に含めた拡張の確認)",
  );

  // ── 対照3: 本タスクでゲートした3関数はゼロのまま ────────────────
  e2eReadBoundaryLeaks.length = 0;

  const { getPricingRule } = await import("../lib/listing/pricingService");
  await getPricingRule("nonexistent-e2e-probe-rule-id");

  const { getShippingReferencePrice } = await import("../lib/shipping/service");
  // e2e-inv-1はlib/inventory/e2eFixtures.tsのE2E_INVENTORY_ROWSに実在する
  // 合成商品(plannedSalePrice設定済み・寸法あり)——実在しないIDを使うと
  // 「対象の在庫が見つかりません」で早期returnし、ShippingRate.list()まで
  // 到達する前に終わってしまうため、境界の対照にならない。
  await getShippingReferencePrice("e2e-inv-1");

  const { isBaseConnected } = await import("../lib/base/oauth");
  await isBaseConnected();

  assertTrue(e2eReadBoundaryLeaks.length === 0, `対照3: getPricingRule/getShippingReferencePrice/isBaseConnectedをfixtureモードで呼んでも境界スパイはゼロ件のまま(実際に検出された内訳: ${JSON.stringify(e2eReadBoundaryLeaks.map((l) => `${l.model}.${l.op}`))})`);

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
