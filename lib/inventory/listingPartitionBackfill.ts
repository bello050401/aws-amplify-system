import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { unwrapList, unwrapWrite } from "@/lib/amplify/listAll";

/**
 * 第六ラウンドP0-5: 真のサーバー側cursor pagination用GSI
 * (`listingPartition`定数パーティション + `listUpdatedAt`ソートキー、
 * amplify/data/resource.tsのInventoryモデルコメント/
 * docs/inventory-cursor-pagination-20260830.md参照)を使うには、
 * 既存の全Inventoryレコードに`listingPartition="ACTIVE"`と
 * `listUpdatedAt`を一度だけ設定しておく必要がある——この2フィールドは
 * 今回新設したフィールドなので、このスキーマ変更より前に作成された
 * レコードには一切値が入っていない(GSIに載らない)。
 *
 * lib/inventory/thumbnailBackfill.tsと全く同じ設計を踏襲する
 * (このファイル自身の冒頭コメントにある通り、持続化ジョブ/ロックは
 * 過剰設計と判断し、単純なDynamoDB nextTokenを呼び出し元へ返す
 * bounded・idempotent・resumableな設計):
 *   - 1回の`advance`呼び出しは高々`RECORDS_PER_ADVANCE`件だけを処理し、
 *     Server Actionのリクエストタイムアウトに余裕を持たせる。
 *   - `listingPartition`が既に設定済みのレコードは書き込みをスキップ
 *     する(何度re-runしても安全 = idempotent)。
 *   - 対象規模はthumbnailBackfillと同じ「せいぜい数百件、ADMINが一度
 *     実行すればよい」スケールであり、ZAICO同期のような1000件超の
 *     ビジネスクリティカルな同期とは投資対効果が異なる。
 *
 * **並び順を壊さないための設計判断(thumbnailBackfillが踏んだ不具合の
 * 再発防止)**: 新規に`listUpdatedAt`を設定する際、値は「今」ではなく
 * そのレコードの**既存の`updatedAt`(Amplify自動管理タイムスタンプ、
 * =バックフィル実行より前の最終更新時刻)**をそのまま複製する。
 * こうすることで、バックフィル自体がレコードを一覧の先頭へ押し上げる
 * ことはなく、新GSIの並び順は旧`updatedAt DESC`の並び順を初期状態
 * として正しく引き継ぐ——このバックフィルが直そうとしている「内部
 * 書き込みが見た目上の並び順を変えてしまう」問題を、このバックフィル
 * 自身が起こしては本末転倒であるため。
 */
const RECORDS_PER_ADVANCE = 50;

export interface ListingPartitionBackfillProgress {
  /** Inventory records scanned this call. */
  scanned: number;
  /** Of those, how many were missing listingPartition and got backfilled this call. */
  backfilled: number;
  /** Pass to the next advanceListingPartitionBackfill call to continue; null means the scan reached the end. */
  nextToken: string | null;
  /** true once nextToken is null — nothing left to scan. */
  done: boolean;
}

export async function advanceListingPartitionBackfill(nextToken: string | null): Promise<ListingPartitionBackfillProgress> {
  // deletedAtの無いもの(=生存レコード)だけが対象——物理削除された
  // 行はテーブルから既に消えているため、ここでのフィルタは「論理削除
  // フラグはあるが実際の削除経路は物理削除のみ」という既存の仕様
  // (app/actions/inventory.tsのdeleteInventory参照)との整合を保つため
  // だけの防御的フィルタ(現状は常にtrueになる)。
  const res = await serverDataClient.models.Inventory.list({
    filter: { deletedAt: { attributeExists: false } },
    nextToken: nextToken ?? undefined,
    limit: RECORDS_PER_ADVANCE,
    ...inventoryAuthMode,
  });
  // 取得エラーを0件と取り違えない。空に化けると nextToken も消えるため、
  // **バックフィルが「完了」と表示されたまま未設定の行が残る**。
  // listingPartition が無い行はGSIに現れない＝一覧に出てこないので、
  // 「取りこぼしを完了と誤認する」ことの実害が大きい。
  const data = unwrapList(res, "バックフィル対象の在庫");
  const nt = res.nextToken;

  let backfilled = 0;
  for (const item of data) {
    if (item.listingPartition) continue; // 既に設定済み — idempotent、再実行しても安全

    // 既存のupdatedAt(バックフィル実行より前の最終更新時刻)をそのまま
    // 複製する——「今」を入れてしまうと、このバックフィル自身が
    // thumbnailBackfillと同種の「一覧の並び順を勝手に押し上げる」
    // 不具合を再現してしまう(このファイル冒頭コメント参照)。
    // 書き込みの失敗も握りつぶさない。失敗を数えないと backfilled が
    // 実際より多く出て、やはり「完了した」ことになってしまう。
    unwrapWrite(
      await serverDataClient.models.Inventory.update(
        { id: item.id, listingPartition: "ACTIVE", listUpdatedAt: item.updatedAt },
        inventoryAuthMode,
      ),
      "listingPartitionのバックフィル",
    );
    backfilled++;
  }

  return {
    scanned: data.length,
    backfilled,
    nextToken: nt ?? null,
    done: !nt,
  };
}
