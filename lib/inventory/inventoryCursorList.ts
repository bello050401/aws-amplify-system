import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { toListRow, type InventoryListRow } from "./queries";

/**
 * 第六ラウンドP0-5(BELLO統合業務OS第六ラウンド再改訂完全版指示書、
 * docs/inventory-cursor-pagination-20260830.md参照)。
 *
 * lib/inventory/queries.tsの`listInventory`/`listInventorySimpleSearch`/
 * `listInventoryAdvanced`は3経路とも「非削除の全件をDynamoDBから取得→
 * アプリ側でupdatedAt DESCソート→配列をoffsetでslice」という設計
 * (fetchAllInventoryRecords、同ファイルのコメント参照)。この設計は
 * テキスト検索・詳細検索(AND/OR混在条件はDynamoDB filter単体で表現
 * できないため、本質的に全件走査+アプリ側判定が必要)には理にかなって
 * いるが、**単純な一覧表示(検索語なし・サイドバーの
 * カテゴリ/保管場所/状態フィルタのみ)**にとってはDynamoDBレベルで
 * ソート済みの結果を直接取得できるのに全件走査している点で、件数が
 * 今後大きく増えた場合にスケールしない根本的な非効率が残っていた。
 *
 * このファイルはその「単純な一覧表示」経路専用に、amplify/data/
 * resource.tsで新設したGSI(`listingPartition`定数パーティション+
 * `listUpdatedAt`ソートキー)を使った**真のDynamoDB Query**
 * (`listInventoryByListingPartitionAndListUpdatedAt`、synth出力で
 * queryField名を実機確認済み)を提供する——全件走査もアプリ側ソートも
 * 行わず、DynamoDB自体がソート済みの1ページ分だけを返す。
 *
 * ## この経路がまだ`listInventory`のデフォルトに切り替わっていない理由
 *
 * 1. **バックフィル未実行**: `listingPartition`/`listUpdatedAt`は今回
 *    新設したフィールドなので、このラウンドより前に作成された既存
 *    レコードには値が入っておらず、このGSIには一切現れない
 *    (lib/inventory/listingPartitionBackfill.ts参照、ADMINが設定画面
 *    から実行する一度きりの移行だが、実データに対して実行し実機検証
 *    した実績はまだ無い)。
 * 2. **総件数(total)を返さない**: cursor pagination方式は本質的に
 *    「currentトークンから次ページを1回のQueryで取得する」方式であり、
 *    offset方式のような「X件中Y〜Z件目」という総件数表示に必要な
 *    "全件のうち何番目か"という概念を持たない。真に安価な総件数
 *    (DynamoDB `Select: COUNT`)を取得するには、Next.jsサーバーの現在の
 *    権限モデル(Amplify Data/AppSync経由のみ、生DynamoDB SDKアクセス
 *    無し——lib/inventory/thumbnailBackfill.tsの監査コメントで既に
 *    「生DynamoDBアクセスは実環境未検証のリスクがあり見送り」と判断
 *    済み)を変える新規インフラ(カスタムQueryリゾルバ等)が必要で、
 *    これも実AWS環境での検証手段が無い今回のラウンドでは追加しない。
 * 3. **「前へ」が1段分しか戻れない**: 下記のbounded 2-tokenカーソル
 *    設計は、無制限にnextTokenを積み上げてURLへ入れていた旧設計の
 *    HTTP 431実障害(既に修正済み、offset方式へ統一した経緯)を二度と
 *    起こさないための意図的な制約であり、「直前の1ページ分だけ戻れる」
 *    ("次へ"を押す前の状態に戻す取り消し操作)までしかサポートしない
 *    ——ページ番号を指定した任意ジャンプや、2ページ以上前への
 *    「戻る」は対象外(DynamoDBのcursorが本質的に前方参照専用の
 *    opaqueトークンであり、AppSyncの内部トークン形式に依存した
 *    双方向カーソルの自前構築は今回検証手段が無いため見送り)。
 *
 * これら3点はUI設計判断(「総件数表示」と「任意ページジャンプ」を
 * 諦めて無限スクロール/シンプルな次へ・前へUIへ移行するかどうか)を
 * 伴うため、自律的なエンジニアリング判断の範囲を超える——今回は
 * 「基盤(GSI+この関数)を用意し、実機検証可能な形で提供する」ところ
 * までとし、`listInventory`自体の切り替えは次回以降の判断に委ねる。
 */

/** 1回のQueryで取得する最大件数(既存の一覧ページサイズと揃える)。 */
const DEFAULT_PAGE_SIZE = 50;

export interface InventoryCursorListFilters {
  categoryIds?: string[];
  locationId?: string;
  statusId?: string;
}

/**
 * Bounded 2-token cursor state — 旧HTTP 431バグ(全訪問済みページの
 * nextTokenをURLへ無制限に積み上げていた設計)の再発を防ぐため、常に
 * 「現在ページを取得するのに使ったトークン(cur)」と「その1つ前の
 * ページを取得するのに使ったトークン(prev)」の2つだけを保持する
 * ——ページを何段先まで進めても、状態のサイズはこの2つのまま増えない。
 *
 * `cur`/`prev`は共にAppSyncが返す不透明(opaque)なnextToken文字列
 * そのもの(null = 1ページ目を取得するのに追加のトークンは不要、
 * という意味)。
 */
export interface CursorPaginationState {
  cur: string | null;
  prev: string | null;
}

export const INITIAL_CURSOR_STATE: CursorPaginationState = { cur: null, prev: null };

/**
 * 「次へ」——現在ページのfetchが返したnextToken(次ページを取得する
 * ための入力トークン)を新しい`cur`に、現在の`cur`(今のページを取得
 * するのに使ったトークン=1つ前のページを取得する入力トークン)を
 * 新しい`prev`にスライドさせる。
 */
export function advanceCursorState(state: CursorPaginationState, returnedNextToken: string | null): CursorPaginationState {
  return { cur: returnedNextToken, prev: state.cur };
}

/**
 * 「前へ」——`prev`(1つ前のページを取得するための入力トークン)を
 * 新しい`cur`とする。新しい`prev`は追跡していないため常に`null`
 * (= さらにもう1段前へは戻れない、ファイル冒頭コメント参照)。
 * `prev`が無い(=1ページ目にいる、または既に1段戻った直後)場合は
 * `null`を返し、呼び出し側は「前へ」ボタンを無効化する。
 */
export function retreatCursorState(state: CursorPaginationState): CursorPaginationState | null {
  if (state.prev === null && state.cur === null) return null; // 既に1ページ目
  return { cur: state.prev, prev: null };
}

/**
 * URL等の外部境界へ渡すための、単一の不透明文字列へのエンコード/
 * デコード——「2つのトークンを別々のクエリパラメータとして積む」
 * ことをせず1個のパラメータにまとめることで、パラメータ数・全体長を
 * 常に一定に保つ(旧HTTP 431バグの再発防止という同じ理由)。
 * Base64はURLセーフ版('+/'→'-_')。壊れた/改ざんされた入力は例外を
 * 投げず`INITIAL_CURSOR_STATE`へ安全にフォールバックする(検索条件を
 * 変えた直後の古いカーソルパラメータが残っていても、単に1ページ目
 * から表示し直すだけで済むようにするため——存在しないSKUで404に
 * するような失敗モードにはしない)。
 */
export function encodeCursorState(state: CursorPaginationState): string {
  if (state.cur === null && state.prev === null) return "";
  const json = JSON.stringify([state.cur, state.prev]);
  return Buffer.from(json, "utf-8").toString("base64url");
}

export function decodeCursorState(encoded: string | null | undefined): CursorPaginationState {
  if (!encoded) return INITIAL_CURSOR_STATE;
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf-8");
    const parsed = JSON.parse(json);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      (typeof parsed[0] === "string" || parsed[0] === null) &&
      (typeof parsed[1] === "string" || parsed[1] === null)
    ) {
      return { cur: parsed[0], prev: parsed[1] };
    }
    return INITIAL_CURSOR_STATE;
  } catch {
    return INITIAL_CURSOR_STATE;
  }
}

export interface InventoryCursorPage {
  items: InventoryListRow[];
  /** 次ページが存在するかどうか(AppSyncのnextTokenがnullでない)。 */
  hasNext: boolean;
  /** 「前へ」が可能かどうか(state.prevが存在する、または既に取得済みのcurが有るためこのページ自体1ページ目ではない)。 */
  hasPrev: boolean;
  /** このページ取得後の新しいカーソル状態(「次へ」を押した場合に渡す)。 */
  nextState: CursorPaginationState;
}

/**
 * 真のDynamoDB Query(listingPartition="ACTIVE"を固定パーティション
 * キーとするGSI、listUpdatedAt DESCでソート済み)による一覧取得。
 *
 * テキスト検索(`q`)・詳細検索(AND/OR混在条件)は対象外——それらは
 * 本質的にDynamoDBのKeyCondition/FilterExpression単体で表現できない
 * ため、引き続きlib/inventory/queries.tsの全件走査経路(
 * listInventorySimpleSearch/listInventoryAdvanced)が正しい実装で
 * あり続ける。カテゴリ/保管場所/状態はDynamoDBのFilterExpressionとして
 * (Queryの一部として、Scanではない)渡せるため対応する。
 */
export async function listInventoryByListingPartitionCursor(
  filters: InventoryCursorListFilters,
  state: CursorPaginationState,
  limit: number = DEFAULT_PAGE_SIZE,
): Promise<InventoryCursorPage> {
  const conditions: Record<string, unknown>[] = [];
  if (filters.categoryIds && filters.categoryIds.length > 0) {
    conditions.push({ or: filters.categoryIds.map((id) => ({ categoryId: { eq: id } })) });
  }
  if (filters.locationId) conditions.push({ locationId: { eq: filters.locationId } });
  if (filters.statusId) conditions.push({ statusId: { eq: filters.statusId } });

  const { data, nextToken, errors } = await serverDataClient.models.Inventory.listInventoryByListingPartitionAndListUpdatedAt(
    { listingPartition: "ACTIVE" },
    {
      sortDirection: "DESC", // listUpdatedAt降順 = 直近で実際に変更された商品が最上位(既存のupdatedAt DESCと同じ意図)
      filter: conditions.length > 0 ? { and: [{ deletedAt: { attributeExists: false } }, ...conditions] } : { deletedAt: { attributeExists: false } },
      nextToken: state.cur ?? undefined,
      limit,
      ...inventoryAuthMode,
    },
  );
  if (errors) throw new Error(`在庫データの取得に失敗しました: ${JSON.stringify(errors)}`);

  return {
    items: data.map(toListRow),
    hasNext: Boolean(nextToken),
    hasPrev: state.cur !== null || state.prev !== null,
    nextState: advanceCursorState(state, nextToken ?? null),
  };
}
