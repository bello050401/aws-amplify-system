import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { buildZaicoSourceLinkId } from "./zaicoSyncEngine";

/**
 * 不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §11: `ZaicoSourceLink`
 * (amplify/data/resource.tsのモデルコメント、lib/inventory/
 * zaicoSyncPorts.tsのfindExistingBySourceId/claimSourceLink参照)は
 * このラウンドで新設したモデルなので、それより前に同期された既存の
 * ZAICO連携Inventoryレコードには一切リンクが存在しない。
 *
 * **このバックフィルは実質的に全件監査でもある**——各レコードについて
 * リンクを新規作成しようとし、`createInventory`と全く同じ「idが既に
 * 存在すれば失敗する」条件付き書き込みに支えられているため、既に別の
 * レコードが同じsourceInventoryIdのリンクを保持していれば、この
 * バックフィル自身がそれを検出する(=重複)。ただし判定・削除は
 * 一切行わない——検出した重複は`duplicatesFound`として報告するのみで、
 * 実際の整理は`lib/inventory/zaicoDuplicateAudit.ts`の
 * `mergeZaicoDuplicate`(ADMINが個別に確認して実行する別のアクション)
 * に委ねる(§11.9「必要な承認点だけ明示する」)。
 *
 * lib/inventory/thumbnailBackfill.ts/listingPartitionBackfill.tsと
 * 全く同じbounded・idempotent・resumable設計(永続ジョブ/ロック無し、
 * 1回の呼び出しは最大50件、既にリンク済みのレコードはスキップ)。
 *
 * どのレコードを「正規」としてリンクを作るかの決定順序が結果に影響
 * しうる(複数の重複のうちどれが最初にこのバックフィルを通過するかで、
 * 一時的にどれがリンクの保持者になるかが決まる)ため、走査順序を
 * createdAt ASC(最古を優先)に揃える——`groupZaicoDuplicates`の正規
 * 候補選定(§11.9「どちらが正しい/古いか」の既定値)と一致させるため。
 * ただし実際の統合(データ移行)はこのバックフィルでは行わない
 * ——リンクの保持者が偶然「最古でない」側になっても、後続の
 * `mergeZaicoDuplicate`実行時に監査結果から選び直せるため実害はない。
 */
const RECORDS_PER_ADVANCE = 50;

export interface ZaicoSourceLinkBackfillProgress {
  scanned: number;
  backfilled: number;
  /** このバックフィル中に新規発見した重複(既にリンク済みのsourceInventoryIdへ別レコードがリンクを試みて失敗したケース)。 */
  duplicatesFound: number;
  nextToken: string | null;
  done: boolean;
}

export async function advanceZaicoSourceLinkBackfill(nextToken: string | null): Promise<ZaicoSourceLinkBackfillProgress> {
  const { data, nextToken: nt } = await serverDataClient.models.Inventory.list({
    filter: { and: [{ deletedAt: { attributeExists: false } }, { sourceSystem: { eq: "ZAICO" } }] },
    nextToken: nextToken ?? undefined,
    limit: RECORDS_PER_ADVANCE,
    ...inventoryAuthMode,
  });

  let backfilled = 0;
  let duplicatesFound = 0;
  for (const item of data) {
    if (!item.sourceInventoryId) continue;
    const linkId = buildZaicoSourceLinkId("ZAICO", item.sourceInventoryId);
    const { data: existingLink } = await serverDataClient.models.ZaicoSourceLink.get({ id: linkId }, inventoryAuthMode);
    if (existingLink) {
      if (existingLink.inventoryId !== item.id) duplicatesFound++; // 既に別のレコードがこのsourceInventoryIdを保持している=重複
      continue; // 既存リンクは上書きしない(先に処理された方を尊重する)
    }
    const { errors } = await serverDataClient.models.ZaicoSourceLink.create(
      { id: linkId, sourceSystem: "ZAICO", sourceInventoryId: item.sourceInventoryId, inventoryId: item.id },
      inventoryAuthMode,
    );
    if (errors) {
      // 条件付き書き込みの競合(このバックフィルの別呼び出しと同時実行
      // された等)——重複としてカウントし、次の実行に委ねる(致命的
      // エラーとしてバックフィル全体を止めない)。
      duplicatesFound++;
      continue;
    }
    backfilled++;
  }

  return {
    scanned: data.length,
    backfilled,
    duplicatesFound,
    nextToken: nt ?? null,
    done: !nt,
  };
}
