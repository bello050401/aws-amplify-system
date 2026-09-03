import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { normalizeProductTitle } from "@/lib/inquiry/scoring";

/**
 * 在庫1件に対応するBASE商品を、**取り違えない範囲で**特定する
 * (2026-09-03 追加指示 §44)。
 *
 * ── なぜ必要か ──────────────────────────────────────────────────
 *
 * 商品説明の生成は在庫の事実だけを使っている。在庫にサイズ・素材・
 * ブランドが入っていなければ、そのセクションは空欄で返る。ところが
 * 同じ商品がBASEに出ていれば、そこには書いてあることがある。
 * 「利用可能なBASE情報があるなら積極的に参照する」(§44)。
 *
 * ── なぜ「似ている商品」を使ってはいけないか ────────────────────
 *
 * 文体の参考(findSimilarArchivedProducts)は**似ている商品**を探す。
 * それは文章の書き方を真似るためのもので、そこに書かれた寸法・素材は
 * 別の商品のものである。補完に使えば、他の商品の事実をこの商品の説明へ
 * 書き込むことになる —— 生成AIに事実を捏造させるのと同じ結果になる。
 *
 * そこでここでは**同一商品と言い切れる根拠**しか使わない:
 *
 *   1. BASEの出品(ChannelListing) … この在庫をBASEへ出したときのID。
 *      人が結び付けた事実で、取り違えようがない。
 *   2. 商品名の完全一致(正規化後)で、かつ候補が1件だけ。
 *      2件以上あるなら、どれがこの在庫かは決められないので使わない。
 *
 * 名前が「似ている」だけのものは採らない。家具は同シリーズ・色違い・
 * サイズ違いが多く、そこを緩めた瞬間に別商品の寸法が混ざる。
 */

export type BaseLinkBasis =
  /** BASEへの出品として登録されている。人が結び付けた事実。 */
  | "CHANNEL_LISTING"
  /** 商品名が正規化後に完全一致し、候補が1件だけだった。 */
  | "EXACT_TITLE";

export interface BaseLink {
  baseItemId: string;
  basis: BaseLinkBasis;
  /** 画面とログに出す説明。 */
  reason: string;
}

/** 商品名の完全一致を探すための、最小限の過去BASE商品。 */
export interface ArchiveTitleRow {
  baseItemId: string;
  title?: string | null;
  titleCore?: string | null;
}

/**
 * BASEの出品から引く。
 *
 * ChannelListing は (inventoryId, channel) で1件に決まる想定だが、
 * 実データで複数あった場合は**決めない** —— どれが現行の出品か
 * 分からないまま片方を採ると、別の商品ページの情報を取り込みうる。
 */
async function fromChannelListing(inventoryId: string): Promise<BaseLink | null> {
  const { data, errors } = await serverDataClient.models.ChannelListing.list({
    filter: { inventoryId: { eq: inventoryId }, channel: { eq: "BASE" } },
    limit: 10,
    ...inventoryAuthMode,
  });
  if (errors) {
    // 引けないことは黙って「無い」にしない。呼び出し側が理由を残せるよう投げる。
    throw new Error(`BASE出品情報の取得に失敗しました: ${errors.map((e) => e.message).join("; ")}`);
  }
  const withId = (data ?? []).filter(
    (row) => typeof row.externalListingId === "string" && row.externalListingId.trim() !== "",
  );
  if (withId.length !== 1) return null;
  return {
    baseItemId: String(withId[0].externalListingId),
    basis: "CHANNEL_LISTING",
    reason: "この在庫のBASE出品として登録されている商品です。",
  };
}

/**
 * 商品名の完全一致から引く(純粋関数)。
 *
 * 正規化は照合と同じ normalizeProductTitle を使う。ここだけ別の正規化を
 * 書くと、問い合わせ側の商品特定と結果が食い違う。
 */
export function findByExactTitle(inventoryName: string, archive: ArchiveTitleRow[]): BaseLink | null {
  const target = normalizeProductTitle(inventoryName);
  if (target.length === 0) return null;
  const hits = archive.filter((row) => {
    const source = row.titleCore ?? row.title;
    return source != null && normalizeProductTitle(source) === target;
  });
  if (hits.length !== 1) return null;
  return {
    baseItemId: hits[0].baseItemId,
    basis: "EXACT_TITLE",
    reason: "過去BASE商品に、商品名が完全に一致するものが1件だけありました。",
  };
}

/**
 * 在庫に対応するBASE商品を探す。見つからなければ null。
 *
 * **見つからないことは失敗ではない。** まだBASEに出していない在庫の
 * 下書きを作る場面では、対応する商品が存在しないのが普通である。
 */
export async function resolveLinkedBaseItem(
  inventoryId: string,
  inventoryName: string,
  archive: ArchiveTitleRow[],
): Promise<BaseLink | null> {
  const listed = await fromChannelListing(inventoryId);
  if (listed) return listed;
  return findByExactTitle(inventoryName, archive);
}
