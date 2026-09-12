import { getInventoryHistory } from "@/lib/inventory/queries";
import { InventoryHistorySection } from "./InventoryHistorySection";

/**
 * P1 詳細遷移の待ち時間短縮(2026-09-12): 商品詳細ページ本体
 * (page.tsx)から更新履歴だけを切り出した非同期Server Component。
 *
 * page.tsx側の<Suspense>境界の中でだけ使う——本体(基本情報・画像・
 * 販売情報等)はgetInventoryDetail(historyを含まない、Inventory.get
 * 単体)の完了だけを待って描画し、このコンポーネントが自分の分
 * (getInventoryHistoryのGSI Query)を個別に待つ。本体の初回描画を
 * InventoryHistory側の往復で遅らせないための分離であって、履歴
 * データそのものの内容・並び順・表示は分割前と一切変えていない。
 *
 * 局所エラー処理レビュー補正(2026-09-12): このコンポーネント自体は
 * async Server Componentで、素朴に書くと getInventoryHistory が投げた
 * 例外がそのままSuspense境界の外——ページ全体のerror境界
 * (app/inventory/error.tsx)へ波及し、本体(基本情報・画像・価格操作)
 * まで巻き込んでエラー画面に差し替わってしまう。ここでtry/catchして
 * 「取得できた行(rows)」か「取得エラー(null)」かに落とし、実際の
 * 表示(空表示との区別・再試行導線)はクライアント側の
 * InventoryHistorySection に委ねる——再試行はページ全体の再読み込み
 * なしに履歴セクションだけをやり直せる必要があるため(本体はもう
 * 速く描画できているのに、再試行のたびに本体まで巻き込んで待たせる
 * のは今回の目的に反する)。
 */
export async function InventoryHistoryTable({ inventoryId }: { inventoryId: string }) {
  let rows: Awaited<ReturnType<typeof getInventoryHistory>> | null = null;
  try {
    rows = await getInventoryHistory(inventoryId);
  } catch (err) {
    // ログは識別情報(inventoryId・changedBy等)を出さない — エラー種別のみ。
    console.warn("[InventoryHistoryTable] 更新履歴の取得に失敗しました(本体の表示は継続します)", {
      error: err instanceof Error ? err.name : "unknown",
    });
  }

  // 商品を切り替えたら(inventoryIdが変わったら)前の商品の読込/エラー
  // 状態を引き継がず作り直す——SalesItemsSection.tsxのkey={`${year}-
  // ${month}`}と同じ「keyでReactの内部stateをリセットする」定石。
  return <InventoryHistorySection key={inventoryId} inventoryId={inventoryId} initialRows={rows} />;
}
