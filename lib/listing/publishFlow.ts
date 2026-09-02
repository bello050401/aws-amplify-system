import type { ChannelListingRecord, ListingChannel, ListingDraftRecord } from "./types";

/**
 * 出品の「BELLO側の手順」だけを取り出したもの。
 *
 * ── なぜ分けるのか ──────────────────────────────────────────────
 *
 * 出品には2つの関心が混ざっている。
 *
 *   1. BELLO側の手順   … 出せる状態か確かめ、PUBLISHING にし、
 *                        結果に応じて ACTIVE か ERROR にする
 *   2. 外部への送信     … Mercari / BASE / (将来) Next Engine・JUNGLE
 *
 * 1はどの出品先でも同じで、2だけが違う。いまは `service.ts` の
 * `listOnMercari` と `listOnBase` が両方を抱えていて、1の50行が
 * まるごと2回書かれている。出品先が増えるたびに、また書き写すことになる。
 *
 * ここに置いてあるのは**1だけ**。純粋関数で、DBにも外部APIにも触らない
 * ので、状態遷移そのものをネットワーク無しで検証できる。
 *
 * ── 外部連携ハブの選定はまだ決まっていない ──────────────────────
 *
 * BELLO → Next Engine → 各モール / BELLO → JUNGLE → 各モール /
 * BELLO → BASE直接API のどれを使うかは未確定。だからこのファイルは
 * **どのハブにも依存しない**。`PublishRoute` が唯一の接点で、
 * 出品先が変わってもここは変わらない形にしてある。
 *
 * いま入れていないもの（意図的）:
 *   ・アダプタのinterface定義        … 経路が決まってから
 *   ・listOnMercari/listOnBase の統合 … 同上
 *
 * ── 挙動は1ミリも変えていない ───────────────────────────────────
 *
 * 既存2関数から**そのまま**取り出した。文言も、キーの有無も、
 * `undefined` と `null` の使い分けも現状のまま。違いがあるところは
 * `PublishRoute` のフィールドとして**明示**した —— 消すのではなく、
 * 見えるようにするのが先。
 */

/** 出品先1つぶん。ここだけが出品先ごとに変わる。 */
export interface PublishRoute {
  /** ChannelListing.channel に入る値。 */
  readonly channel: ListingChannel;
  /** 「既に○○へ出品済みです」の○○。 */
  readonly displayName: string;
  /** ChannelListing がまだ無いときの案内。出品先ごとに設定画面が違うので文言も違う。 */
  readonly notConfiguredMessage: string;
  /**
   * 出品成功時に listingUrl を null で明示的に消すか。
   *
   * **現状 Mercari だけ true。** Mercari の createProduct 応答に
   * listingUrl 相当が含まれるか未確認のため、以前の値が残らないよう
   * 毎回消している。BASE 側は同じ状況なのにキー自体を送っておらず、
   * 既存値があればそのまま残る。
   *
   * どちらが正しいかは応答仕様を確認しないと決められないので、いまは
   * **揃えずにフラグとして残す**。揃えるとどちらかの挙動が変わる。
   */
  readonly clearsListingUrlOnPublish: boolean;
  /** ログの接頭辞。`[listOnMercari]` 等、既存の文字列をそのまま使う。 */
  readonly logLabel: string;
}

export const MERCARI_ROUTE: PublishRoute = {
  channel: "MERCARI_SHOPS",
  displayName: "Mercari Shops",
  notConfiguredMessage: "先にMercariのカテゴリー設定を保存してください。",
  clearsListingUrlOnPublish: true,
  logLabel: "listOnMercari",
};

export const BASE_ROUTE: PublishRoute = {
  channel: "BASE",
  displayName: "BASE",
  notConfiguredMessage: "先にBASEのチャネル設定を保存してください。",
  clearsListingUrlOnPublish: false,
  logLabel: "listOnBase",
};

/* ══════════════════════════════════════════════════════════════════
 * 出せる状態かどうか
 * ══════════════════════════════════════════════════════════════════ */

export const NO_DRAFT_MESSAGE = "先に出品下書きを保存してください。";
export const NO_INVENTORY_MESSAGE = "対象の在庫が見つかりません。";

/** 下書きが無ければ出品できない。 */
export function requireDraft(draft: ListingDraftRecord | null): asserts draft is ListingDraftRecord {
  if (!draft) throw new Error(NO_DRAFT_MESSAGE);
}

/** チャネル設定が無ければ出品できない。文言は出品先ごとに違う。 */
export function requireChannelListing(
  channelListing: ChannelListingRecord | null,
  route: PublishRoute,
): asserts channelListing is ChannelListingRecord {
  if (!channelListing) throw new Error(route.notConfiguredMessage);
}

/**
 * 既に出品済みなら止める。
 *
 * 判定は「ACTIVE **かつ** 外部IDがある」の両方。片方だけでは出品済みと
 * みなさない —— ACTIVE なのに外部IDが無い行は、状態だけ進んで実際には
 * 出せていないので、もう一度出させる必要がある。
 */
export function assertNotAlreadyListed(channelListing: ChannelListingRecord, route: PublishRoute): void {
  if (channelListing.status === "ACTIVE" && channelListing.externalListingId) {
    throw new Error(
      `既に${route.displayName}へ出品済みです（商品ID: ${channelListing.externalListingId}）。再出品（更新）は現時点では未対応の機能です。`,
    );
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 状態遷移
 * ══════════════════════════════════════════════════════════════════
 * どれも「ChannelListing.update へ渡す形」をそのまま返す。DBは触らない。
 */

export interface PublishingPatch {
  id: string;
  status: "PUBLISHING";
  updatedBy: string | undefined;
}

/** 外部APIを叩く直前。「呼び出し中」を残しておかないと、途中で落ちたときに何も分からない。 */
export function publishingPatch(channelListingId: string, who: string | null): PublishingPatch {
  return { id: channelListingId, status: "PUBLISHING", updatedBy: who ?? undefined };
}

/** 外部APIが返した結果のうち、BELLOが保存するもの。 */
export interface PublishSuccess {
  externalProductId: string;
}

export interface PublishedPatch {
  id: string;
  status: "ACTIVE";
  externalListingId: string;
  listingUrl?: null;
  firstListedAt: string;
  lastListedAt: string;
  lastError: undefined;
  updatedBy: string | undefined;
}

/**
 * 出品成功。
 *
 * `firstListedAt` は初回だけ入れ、既にあれば**上書きしない**。
 * `lastListedAt` は成功のたびに更新する。再出品が未実装のいまは実質
 * 同時刻になるが、意味の違う2つを1つにまとめてしまうと、再出品を
 * 実装したときに初回日時が失われる。
 *
 * `lastError: undefined` は「前回の失敗を消す」。成功したのに古い
 * エラーが残っていると、画面上は成功なのにエラー文が併記される。
 */
export function publishedPatch(params: {
  channelListing: ChannelListingRecord;
  result: PublishSuccess;
  route: PublishRoute;
  who: string | null;
  nowIso: string;
}): PublishedPatch {
  const { channelListing, result, route, who, nowIso } = params;
  const patch: PublishedPatch = {
    id: channelListing.id,
    status: "ACTIVE",
    externalListingId: result.externalProductId,
    firstListedAt: channelListing.firstListedAt ?? nowIso,
    lastListedAt: nowIso,
    lastError: undefined,
    updatedBy: who ?? undefined,
  };
  if (route.clearsListingUrlOnPublish) patch.listingUrl = null;
  return patch;
}

export interface FailedPatch {
  id: string;
  status: "ERROR";
  lastError: string;
  updatedBy: string | undefined;
}

/** 出品失敗。理由を必ず残す —— 「失敗した」だけでは次にやることが決まらない。 */
export function failedPatch(channelListingId: string, message: string, who: string | null): FailedPatch {
  return { id: channelListingId, status: "ERROR", lastError: message, updatedBy: who ?? undefined };
}

/**
 * 例外から利用者向けの文言を取り出す。
 *
 * 既存実装は `err instanceof MercariApiError ? err.message : err instanceof
 * Error ? err.message : "不明なエラー"` と書かれていたが、前2つは同じ値を
 * 返すので、実質「Errorならmessage、それ以外は不明なエラー」でしかない。
 * つまり**もともとチャネル固有の分岐は無かった**。ここで1つに畳んでも
 * 挙動は変わらない。
 */
export function describePublishFailure(err: unknown): string {
  return err instanceof Error ? err.message : "不明なエラー";
}

/** 保存自体が失敗したときの文言。成功したのに保存できていない状態を黙って通さない。 */
export function saveFailureMessage(errors: unknown): string {
  return `出品結果の保存に失敗しました: ${JSON.stringify(errors)}`;
}
