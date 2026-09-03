import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";

/**
 * ZAICO同期がどれだけ新しいかを、商品特定の判断材料として使う。
 *
 * ── なぜ要るか(2026-09-03 利用者指示) ────────────────────────────
 *
 * 「在庫側で販売中になっていないのは、実際に販売中ではないからではない。
 *  ZAICO側では現在販売中だが、BELLO側への同期がまだ反映し切れていないだけ」
 *
 * つまり **BELLOの在庫カテゴリは、BASEの出品状態より遅れることがある**。
 * 「販売中カテゴリに無い → 対象外」と即断すると、実際には売っている商品の
 * 問い合わせを取りこぼす。同期がどれだけ古いかを、フォールバックしてよいか
 * の判断と、担当者への説明に使う。
 */

/**
 * これを超えたら「同期が古い」とみなす時間。
 *
 * ZAICO同期は日次〜数時間おきの運用なので、6時間を超えていれば
 * 「BELLO側が最新とは限らない」と考えてよい。**この値は
 * フォールバックの可否を決めるものではない**(BASEの強い手がかりが
 * あればどちらでも辿る)。担当者への説明の言い回しを変えるために使う。
 */
export const ZAICO_SYNC_STALE_HOURS = 6;

export interface ZaicoSyncFreshness {
  /** 最後に同期が完了した時刻。分からなければ null。 */
  lastSyncedAt: string | null;
  /** 経過時間(時)。分からなければ null。 */
  ageHours: number | null;
  /**
   * 古い、または分からない。
   *
   * **分からない場合も true にする。** 「新しいはず」と仮定して
   * フォールバックを止めるより、遅れているかもしれない前提で候補を
   * 見に行くほうが安全(取りこぼしのほうが害が大きい)。
   */
  isStale: boolean;
}

const CACHE_TTL_MS = 60_000;
let cache: { at: number; value: ZaicoSyncFreshness } | null = null;

export function clearZaicoSyncFreshnessCache(): void {
  cache = null;
}

export async function getZaicoSyncFreshness(): Promise<ZaicoSyncFreshness> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const unknown: ZaicoSyncFreshness = { lastSyncedAt: null, ageHours: null, isStale: true };
  try {
    const { data, errors } = await serverDataClient.models.ZaicoSyncJob.list({ limit: 200, ...inventoryAuthMode });
    if (errors && errors.length > 0) {
      console.warn("[zaicoSyncFreshness] 同期ジョブを読めませんでした。", errors.map((e) => e.message).join("; "));
      return unknown;
    }
    const jobs = (data ?? []) as unknown as {
      status?: string | null;
      finishedAt?: string | null;
      lastSuccessfulSyncAt?: string | null;
    }[];

    // lastSuccessfulSyncAt が本来の基準だが、実測では COMPLETED でも
    // null のことがある(差分同期のチェックポイントが記録されていない)。
    // 完了時刻で代替する —— ここで null を返すと「常に古い」となり、
    // 判断材料として役に立たなくなる。
    const times = jobs
      .filter((j) => j.status === "COMPLETED")
      .map((j) => j.lastSuccessfulSyncAt ?? j.finishedAt ?? null)
      .filter((v): v is string => Boolean(v))
      .sort();
    const lastSyncedAt = times[times.length - 1] ?? null;
    if (!lastSyncedAt) return unknown;

    const parsed = Date.parse(lastSyncedAt);
    if (!Number.isFinite(parsed)) return unknown;
    const ageHours = (Date.now() - parsed) / 3_600_000;
    const value: ZaicoSyncFreshness = {
      lastSyncedAt,
      ageHours,
      isStale: ageHours > ZAICO_SYNC_STALE_HOURS,
    };
    cache = { at: Date.now(), value };
    return value;
  } catch (err) {
    console.warn("[zaicoSyncFreshness] 同期状況を取得できませんでした。", err instanceof Error ? err.message : String(err));
    return unknown;
  }
}
