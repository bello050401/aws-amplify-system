/**
 * 詳細履歴の実境界試験(2026-09-12、task_a748ee69c990317c24)。
 *
 * scripts/verify-inventory-history-resilience.ts は
 * lib/inventory/historyDisplay.ts(依存ゼロの表示ヘルパー)しか実行して
 * おらず、次の2つは「コードは数行で単純、目視レビューで代替」として
 * 実行未確認のまま残っていた(docs/inventory-detail-latency-p1-
 * 20260912.md §6.2参照):
 *   1. lib/inventory/queries.ts の getInventoryHistory — GraphQL errors
 *      チェック・非GraphQL例外(reject)の伝播。
 *   2. app/inventory/(protected)/[id]/InventoryHistoryTable.tsx —
 *      getInventoryHistory の失敗を実際にcatchし、InventoryHistorySection
 *      へ null/rows のどちらを渡すか。
 *
 * scripts/verify-sales-aggregate-store-boundary.ts と同じ設計——
 * 対象モジュール自体は実物のままimportし、その1つ下の境界
 * (lib/amplify/dataClient.ts の serverDataClient)だけをmockへ差し替える
 * (scripts/__mocks__/inventoryHistory.dataClient.mock.cjs)。
 *
 * InventoryHistorySection.tsx(Client Component、useStateの状態遷移)は
 * ここでは対象外——Reactのdispatcherが無いこのNode単体実行環境では
 * hooksを含む関数コンポーネントを直接呼び出せない(rules-of-hooks違反
 * でthrowする)。ここは実ブラウザ側
 * (scripts/qa-inventory-history-boundary.cjs、docs/inventory-detail-
 * history-boundary-qa-20260912.md参照)で検証する。InventoryHistoryTable
 * は async Server Component で hooks を使わないため、関数として直接
 * 呼び出して返り値のReact要素(InventoryHistorySectionへ渡るprops)を
 * 検査できる——実際にレンダリングはしない。
 *
 * 実行: node scripts/with-server-only-stub.cjs scripts/verify-inventory-history-boundary.ts
 */
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import * as React from "react";

// InventoryHistoryTable.tsx/InventoryHistorySection.tsx はNext.jsのSWC経由
// (jsx: "react-jsx"自動ランタイム)でビルドされる前提のJSXを書いている
// (自分でReactをimportしていない)。tsx(esbuild)単体でこのファイルを
// 直接importすると、tsconfig.jsonの`"jsx": "preserve"`(Next.js委譲用)
// がesbuildにはそのまま渡せずclassic変換(`React.createElement`呼び出し
// をそのまま埋め込む、暗黙のimportは追加しない)にフォールバックする
// ——グローバルへReactを1つ置いておけば、そのフリー変数参照が解決される
// (このファイル自体の実行にしか影響しない、Next.js本体のビルドには一切
// 関与しない)。
(globalThis as unknown as { React: typeof React }).React = React;

declare module "node:module" {
  export function registerHooks(hooks: {
    resolve?: (
      specifier: string,
      context: { parentURL?: string },
      nextResolve: (specifier: string, context: unknown) => unknown,
    ) => unknown;
  }): void;
}

const projectRoot = pathToFileURL(process.cwd() + "/").href;
const mocksDir = pathToFileURL(process.cwd() + "/scripts/__mocks__/").href;
const DATA_CLIENT_MOCK_URL = mocksDir + "inventoryHistory.dataClient.mock.cjs";

registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    // lib/inventory/queries.ts からの "@/lib/amplify/dataClient" importだけを
    // 差し替える——他のどの呼び出し元(InventoryHistoryTable.tsx含む)から
    // 見てもqueries.tsは本物のまま、その先のdataClientだけが差し替わる。
    if (context.parentURL?.endsWith("/lib/inventory/queries.ts") && specifier === "@/lib/amplify/dataClient") {
      return { url: DATA_CLIENT_MOCK_URL, shortCircuit: true };
    }
    const target = specifier.startsWith("@/") ? projectRoot + specifier.slice(2) : specifier;
    try {
      return nextResolve(target, context);
    } catch {
      try {
        return nextResolve(target + ".ts", context);
      } catch {
        // InventoryHistoryTable/InventoryHistorySection はJSXを含む.tsxファイル。
        return nextResolve(target + ".tsx", context);
      }
    }
  },
});

let passes = 0;
let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  if (ok) {
    passes++;
    console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`✗ FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function historyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "h1",
    inventoryId: "inv-1",
    changedAt: "2026-09-01T00:00:00.000Z",
    changedBy: "tester@example.com",
    fieldName: "statusId",
    oldValue: "st-photo",
    newValue: "st-listing",
    ...overrides,
  };
}

async function main() {
  const { getInventoryHistory } = await import("@/lib/inventory/queries");
  const mock = await import(DATA_CLIENT_MOCK_URL);

  // ══════════════════ 1. lib/inventory/queries.ts の境界 ══════════════════
  console.log("── queries.ts: getInventoryHistory ─────────────────────────");

  // シナリオ1: GraphQL errors(dataあり・errorsもあり) → 例外を投げる
  {
    mock.__setListResult({ data: [], errors: [{ message: "Not Authorized" }] });
    let threw = false;
    try {
      await getInventoryHistory("inv-1");
    } catch {
      threw = true;
    }
    check(threw, "★要件: GraphQL errorsがあれば例外を投げる(dataが空配列でも黙って通さない)");
  }

  // シナリオ2: 非GraphQLエラー(通信断・タイムアウト等、reject) → そのまま伝播
  {
    mock.__setListRejection(new Error("network down"));
    let threw = false;
    let message = "";
    try {
      await getInventoryHistory("inv-1");
    } catch (e) {
      threw = true;
      message = e instanceof Error ? e.message : String(e);
    }
    check(threw && message === "network down", "★要件: 非GraphQLの例外(reject)もそのまま呼び出し元へ伝播する");
  }

  // シナリオ3: 正常値 → sortされたInventoryHistoryRow[]を返す(古い→新しいの逆順=新しい順)
  {
    mock.__setListResult({
      data: [historyRow({ id: "h-old", changedAt: "2026-08-01T00:00:00.000Z" }), historyRow({ id: "h-new", changedAt: "2026-09-01T00:00:00.000Z" })],
      errors: undefined,
    });
    const rows = await getInventoryHistory("inv-1");
    check(rows.length === 2, "正常値: 件数がそのまま届く");
    check(rows[0]?.id === "h-new" && rows[1]?.id === "h-old", "★要件: changedAt降順(新しい順)にソートされる", JSON.stringify(rows.map((r) => r.id)));
    check(mock.calls.list[0]?.key.inventoryId === "inv-1", "★要件: 指定したinventoryIdでGSI Queryを呼ぶ(Scanではない)");
  }

  // シナリオ4: 正常値・0件 → 空配列(エラーではない)
  {
    mock.__setListResult({ data: [], errors: undefined });
    const rows = await getInventoryHistory("inv-1");
    check(Array.isArray(rows) && rows.length === 0, "★要件: 実0件はエラーではなく空配列(取得失敗と区別できる形)");
  }

  // ══════════════════ 2. InventoryHistoryTable.tsx の境界 ══════════════════
  console.log("\n── InventoryHistoryTable.tsx: try/catchによる局所化 ─────────");
  const { InventoryHistoryTable } = await import("@/app/inventory/(protected)/[id]/InventoryHistoryTable");
  const { InventoryHistorySection } = await import("@/app/inventory/(protected)/[id]/InventoryHistorySection");

  type ProbedElement = { type: unknown; key: unknown; props: { initialRows: unknown; inventoryId: unknown } };
  function asProbed(el: unknown): ProbedElement {
    return el as ProbedElement;
  }

  // シナリオ5: getInventoryHistoryが例外を投げても、Tableは外へ投げず
  // InventoryHistorySectionへinitialRows=nullを渡す(ページ全体のerror
  // 境界へ波及しない、というP1改修の核心)。
  {
    mock.__setListRejection(new Error("boom"));
    let threw = false;
    let element: ProbedElement | undefined;
    try {
      element = asProbed(await InventoryHistoryTable({ inventoryId: "inv-err" }));
    } catch {
      threw = true;
    }
    check(!threw, "★要件: getInventoryHistoryの例外はInventoryHistoryTableの外へ伝播しない");
    check(element?.type === InventoryHistorySection, "InventoryHistorySectionへ委譲する");
    check(element?.props.initialRows === null, "★要件: 取得失敗はinitialRows=null(空配列と区別する)として渡す");
    check(element?.props.inventoryId === "inv-err", "inventoryIdをそのまま渡す");
  }

  // シナリオ6: GraphQL errorsでqueries.tsが投げた例外も同じくcatchされる。
  {
    mock.__setListResult({ data: null, errors: [{ message: "transient" }] });
    let threw = false;
    let element: ProbedElement | undefined;
    try {
      element = asProbed(await InventoryHistoryTable({ inventoryId: "inv-graphql-err" }));
    } catch {
      threw = true;
    }
    check(!threw, "GraphQL errors経由の例外もTableの外へ伝播しない");
    check(element?.props.initialRows === null, "GraphQL errors経由もinitialRows=null");
  }

  // シナリオ7: 正常値 → initialRowsに実際の行配列、keyはinventoryId
  // (商品を切り替えたときにInventoryHistorySectionの内部stateを
  // リセットするための定石——SalesItemsSection.tsxと同じ)。
  {
    mock.__setListResult({ data: [historyRow({ id: "h-ok" })], errors: undefined });
    const element = asProbed(await InventoryHistoryTable({ inventoryId: "inv-ok" }));
    const rows = element.props.initialRows as { id: string }[];
    check(rows.length === 1 && rows[0]?.id === "h-ok", "正常値: 実際の行配列がinitialRowsに渡る");
    check(element.key === "inv-ok", "★要件: key=inventoryId(別商品へ切り替えたときにReactの内部stateをリセットする)");
  }

  // シナリオ8: 商品を切り替えると(inventoryIdが変わると)keyも変わる
  // ——Reactは異なるkeyを別コンポーネントとして扱い、旧商品のuseState
  // (error/retrying等)を新しいインスタンスへ引き継がない。
  {
    mock.__setListResult({ data: [], errors: undefined });
    const elementA = asProbed(await InventoryHistoryTable({ inventoryId: "inv-A" }));
    const elementB = asProbed(await InventoryHistoryTable({ inventoryId: "inv-B" }));
    check(elementA.key !== elementB.key, "★要件: 別商品は別key(旧商品のロード/エラー状態を引き継がない)", `${String(elementA.key)} vs ${String(elementB.key)}`);
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
