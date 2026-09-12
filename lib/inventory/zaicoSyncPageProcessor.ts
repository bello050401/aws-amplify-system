// "server-only"は付けない: このファイルはamplify/functions/zaico-sync-worker/
// handler.ts(Lambda、Next.jsサーバーコンテキストの外)からも直接importされる
// ——lib/inventory/zaicoSyncEngine.ts・zaicoDelta.tsと同じ扱い。
import type { ZaicoInventory } from "@/lib/zaico/client";
import type { ZaicoSyncPort, MasterCache, InventoryModel } from "./zaicoSyncPorts";
import { syncOneZaicoItem } from "./zaicoSyncEngine";
import { splitByDelta } from "./zaicoDelta";

/**
 * ZAICO同期タスク(2026-09-11 設計見直し): 1ページぶんの「差分で省く/
 * 実際に同期する」振り分けと、実際の同期処理そのものをまとめた共通部品。
 *
 * ── なぜ切り出したか ─────────────────────────────────────────────
 *
 * `lib/inventory/zaicoBackgroundSync.ts`(ブラウザ起点のadvance)は
 * `splitByDelta`を使って差分を適用していたが、5分毎に自動実行される
 * `amplify/functions/zaico-sync-worker/handler.ts`(実際に無人で
 * 本番を回している経路 — resource.tsの「ブラウザを閉じてもPCの電源を
 * 落としても最後まで進む」がまさにこの経路を指す)は`splitByDelta`を
 * 一切使わず、`seenSourceIds`以外の全件に`syncOneZaicoItem`を呼んで
 * いた。つまり差分同期の効果は、常時稼働している本番経路には
 * 一度も適用されていなかった(ブラウザの手動「今すぐ1ページ進める」
 * ボタンでしか効かない飾りになっていた)。
 *
 * この関数はその判定+実行ロジックを1箇所にまとめ、handler.tsから
 * AWS SDK(DynamoDB/S3)を経由せず`port`だけで呼べるようにする——
 * `port`を差し替えれば実AWSに一切触れずテストできる(既存の
 * `scripts/verify-zaico-sync.ts`のcreateMockPortパターンをそのまま使える)。
 *
 * ブラウザ側(`advanceOnePage`)は独自のページ内バッチ上限
 * (`ITEMS_PER_ADVANCE`スライス)を持っており、そこまで手を入れると
 * 動いている経路を無用に触ることになるため、今回はこの関数を
 * handler.ts専用として導入するに留める(将来ブラウザ側もここへ
 * 寄せる余地はあるが、このtaskのスコープ外)。
 *
 * ── 2026-09-12 追記: `existingBySourceId`は呼び出し元が1回だけ用意する ──
 *
 * 当初(2026-09-11)の設計は「対象0件のページではfetchAllZaicoManaged
 * 自体を呼ばない」という最適化だけで、時刻ベースのskip判定
 * (splitByDelta)がBELLO未取込の商品を古いZAICO更新日時のせいで
 * 永久にskipし続けてしまう抜け穴があった(lib/inventory/zaicoDelta.ts
 * のsplitByDeltaコメント参照)。塞ぐには「skipしてよいと判定された
 * 商品が本当にBELLOに存在するか」をタダ同然で確認できる必要がある。
 *
 * そこでこの関数自身がfetchAllZaicoManaged(Inventory全件Scan相当)を
 * 呼ぶのをやめ、**呼び出し元(handler.ts)がLambda 1回の呼び出し
 * (invocation)につき1回だけ**先に取得したMapを`existingBySourceId`
 * として受け取るようにした。1回のinvocationは複数ページを処理し
 * 得るが、Scanは常に高々1回——「対象0件のページではScanしない」
 * 旧最適化より**さらに強い**削減(旧設計は変更ありページの数だけ
 * Scanが増えた)であり、かつ全ページ・全skip候補についてBELLO実在
 * 確認がタダ(Mapの.hasのO(1)ルックアップ)で行えるようになる。
 */

export interface DeltaPageCounts {
  totalProcessed: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  imageImported: number;
  skippedByDelta: number;
}

export function emptyDeltaPageCounts(): DeltaPageCounts {
  return { totalProcessed: 0, created: 0, updated: 0, unchanged: 0, failed: 0, imageImported: 0, skippedByDelta: 0 };
}

export interface DeltaPageOutcome {
  counts: DeltaPageCounts;
  /**
   * 今回のページで「観測済み」にできたsourceId(呼び出し側が
   * seenSourceIdsへ足す分)。実際に処理したもの＋差分で省いたものの
   * 両方を含む——省いたものを観測済みに入れないと、完了時の
   * 「ZAICOから無くなった在庫の検出」が誤検出になる。
   */
  observedSourceIds: string[];
  /** 時間切れで打ち切ったため、渡されたpendingの一部が未処理のまま残っている。 */
  budgetExhausted: boolean;
}

/**
 * `pending`(このページのうち、まだ観測していないもの)を差分判定へ
 * かけ、対象になったものだけ`syncOneZaicoItem`へ渡す。
 *
 * - `since`が`null`なら全件が対象(初回・FULLモード)。
 * - `existingBySourceId`は呼び出し元がこのLambda invocation(1同期tick)
 *   につき**1回だけ**`port.fetchAllZaicoManaged()`した結果をそのまま
 *   渡す。この関数自身は絶対に`fetchAllZaicoManaged`を呼ばない
 *   (呼び出しはfile冒頭コメント参照)——ページを何回呼んでも追加の
 *   Inventory全件Scanは発生しない。
 * - `splitByDelta`には`existingBySourceId`をexistsInBello判定として
 *   渡す。時刻だけならskipになる商品でも、BELLOにまだ実在しない
 *   (＝未取込)なら`toProcess`側へ回る——取りこぼし防止の核心。
 * - `isBudgetExhausted()`はアイテムを1件処理するたびに確認する
 *   (handler.ts側のLambda実行時間予算チェックと同じ粒度)。
 */
export async function syncPendingItemsWithDelta(
  pending: ZaicoInventory[],
  since: string | null,
  who: string | null,
  port: ZaicoSyncPort,
  isBudgetExhausted: () => boolean,
  existingBySourceId: Map<string, InventoryModel>,
): Promise<DeltaPageOutcome> {
  const { toProcess, skipped } = splitByDelta(pending, since, (item) => existingBySourceId.has(String(item.id)));
  const observedSourceIds: string[] = skipped.map((item) => String(item.id));
  const counts = emptyDeltaPageCounts();
  counts.skippedByDelta = skipped.length;

  if (toProcess.length === 0) {
    return { counts, observedSourceIds, budgetExhausted: false };
  }

  const masterCache: MasterCache = { categories: new Map(), locations: new Map() };

  let budgetExhausted = false;
  for (const zaicoItem of toProcess) {
    if (isBudgetExhausted()) {
      budgetExhausted = true;
      break;
    }
    const result = await syncOneZaicoItem(zaicoItem, who, existingBySourceId, port, masterCache);
    observedSourceIds.push(result.zaicoId);
    counts.totalProcessed += 1;
    if (result.status === "created") counts.created += 1;
    else if (result.status === "updated") counts.updated += 1;
    else if (result.status === "unchanged") counts.unchanged += 1;
    else counts.failed += 1;
    if (result.imageImported) counts.imageImported += 1;
  }

  return { counts, observedSourceIds, budgetExhausted };
}

/** 呼び出し元(handler.ts)がページをまたいでcountsを積み上げるためのヘルパー。 */
export function mergeDeltaPageCounts(a: DeltaPageCounts, b: DeltaPageCounts): DeltaPageCounts {
  return {
    totalProcessed: a.totalProcessed + b.totalProcessed,
    created: a.created + b.created,
    updated: a.updated + b.updated,
    unchanged: a.unchanged + b.unchanged,
    failed: a.failed + b.failed,
    imageImported: a.imageImported + b.imageImported,
    skippedByDelta: a.skippedByDelta + b.skippedByDelta,
  };
}
