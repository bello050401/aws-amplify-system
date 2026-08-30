import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { normalizeImageRecord, type InventoryImageRecord } from "./imageTypes";
import { generateInventoryThumbnail } from "./thumbnail";

/**
 * BELLO統合改修 master指示書 Phase B優先度4(既存画像のバックグラウンド
 * バックフィル) — every image created from here on gets its thumbnail at
 * upload/sync time (see thumbnail.ts), but every image that existed
 * before this Phase shipped still has `thumbnailKey: null` and falls
 * back to serving its full-resolution original in the list view (see
 * imageTypes.ts's effectiveListThumbnailKey) until it's either re-saved
 * (resolveImages self-heals it, see app/actions/inventory.ts) or this
 * backfill processes it directly.
 *
 * Deliberately NOT a persisted job/lock like lib/inventory/
 * zaicoBackgroundSync.ts's ZaicoSyncJob — that machinery exists there to
 * solve resume-after-interruption for a run that can span the ENTIRE
 * ZAICO catalog (potentially 1000+ items) and must never duplicate a
 * created record if re-run. This backfill has neither property: it's
 * idempotent by construction (an image with a thumbnail already is
 * simply skipped, cheaply, on every re-scan — never re-generated, never
 * duplicated) and its total input size is bounded by however many
 * Inventory images this account actually has, the same "a few hundred
 * records" scale the rest of this app is already sized around. A plain
 * cursor (DynamoDB nextToken) passed back to the client between bounded
 * calls is sufficient — building a second persisted-job architecture
 * here would be exactly the "過剰設計" (over-engineering) the master
 * instructions elsewhere explicitly warn against.
 *
 * BELLO統合改修 master指示書(2026-08-29統合改修版) §優先度C-14 audit
 * (このバックフィルを「本物のバックグラウンド処理にするか、そうでな
 * いなら誠実に表示し直すか」): ThumbnailBackfillPanel.tsx (UI) は既に
 * 誠実な表現になっている——「この画面を開いている間、少しずつ処理し
 * ます」「画面を閉じた場合は『続きから実行』で前回の続きから再開でき
 * ます」とだけ書いてあり、閉じても自動継続するとは一切主張していない
 * (lib/inventory/zaicoSyncPorts.tsのZAICO側と違い、こちらは元から
 * 誇大表示になっていなかったため、UI文言の修正は不要と判断した)。
 *
 * 本物のAWSネイティブなバックグラウンド化(ブラウザ/PCを閉じても進む)
 * については、lib/inventory/zaicoSyncPorts.tsで今回新たに調査した
 * ブロッカー(`backend.data.resources.tables`経由の生DynamoDB書き込みは
 * 実環境未検証のitem形状を手組みするリスクがある/Cognitoサービスアカ
 * ウント+JWT方式はAmplify SSRの内部実装への未検証の仮定に依存する)が
 * そのまま当てはまる。しかもこちらは「システム全体で高々数百枚、ADMIN
 * が任意のタイミングで一度だけ回せばよい」低リスクな最適化作業であり、
 * ZAICO同期(1000件超・ビジネスクリティカルなデータ同期)ほどの投資対
 * 効果がそもそもない——よって今回のラウンドでは着手しない、という
 * 判断とする(「本物のbackground化」は技術的に不可能ではなく、優先度
 * が著しく低いという結論)。
 *
 * このaudit中に新たに発見した、別の実害のある既知の残課題(未修正):
 * `advanceThumbnailBackfill`のInventory.update()呼び出しは、
 * サムネイルキー(ユーザーには見えない内部フィールド)しか書き込んで
 * いないにもかかわらず、Amplifyの自動管理タイムスタンプである
 * `Inventory.updatedAt`を「今」へ更新してしまう——Inventoryモデルには
 * BaseOAuthTokenのような明示的updatedAtフィールドが無く、`.update()`
 * が成功する限りAppSync側リゾルバが無条件にnow()へ上書きするため、
 * ミューテーション変数として古い値を渡し直す方法もない。今回のラウン
 * ドでlib/inventory/queries.tsの一覧デフォルトソートをupdatedAt DESC
 * (直近で実際に変更された商品が最上位)へ修正したことで、この副作用が
 * 初めて実害になった——ADMINが一括バックフィルを実行すると、対象と
 * なった(サムネイル未生成だった)全レコードが、ユーザーから見て何も
 * 変わっていないにもかかわらず一覧最上位付近へ押し上げられてしまう。
 *
 * 対処を保留した理由: 唯一の直し方はInventoryへ独立した「実コンテンツ
 * 変更日時」用の追加フィールド(例: contentUpdatedAt、既存行はnull=
 * 未設定として旧updatedAtへフォールバック、という本アプリで何度も
 * 使われてきた追加的フィールドの定石と同じ形)を新設し、一覧ソートを
 * そちらへ切り替えたうえで、真にユーザー向け変更を行う書き込み経路
 * (編集画面保存/一括編集/インライン編集/ZAICO実差分同期/重複統合/
 * インポート——このバックフィル以外の`Inventory.update()`呼び出し
 * 全箇所)へ明示的にセットして回る、というスキーマ変更を伴う対応にな
 * る。デプロイ済みAWS環境が無くこの変更を実機検証できない状態で、
 * 複数ファイルにまたがる書き込み経路をまとめて変更するのは今回のラウ
 * ンドの「検証できないものは出荷しない」という方針に反するため、意図
 * 的に見送り、完了報告の残課題として明記する。
 */

/** How many Inventory records one `advance` call scans — bounded so a single Server Action call can never approach the ~3 minute request timeout even in the worst case (every image on every one of these records missing its thumbnail). */
const RECORDS_PER_ADVANCE = 20;

export interface ThumbnailBackfillProgress {
  /** Inventory records scanned this call (not necessarily all needing work — most images already have a thumbnail after the first few passes). */
  scanned: number;
  /** Images that had no thumbnailKey yet and were attempted this call. */
  attempted: number;
  /** Of those, how many actually got a thumbnail generated (the rest failed — logged in generateInventoryThumbnail, never fatal here either). */
  generated: number;
  /** Pass to the next advanceThumbnailBackfill call to continue; null means the scan reached the end. */
  nextToken: string | null;
  /** true once nextToken is null — nothing left to scan. */
  done: boolean;
}

export async function advanceThumbnailBackfill(nextToken: string | null): Promise<ThumbnailBackfillProgress> {
  const { data, nextToken: nt } = await serverDataClient.models.Inventory.list({
    filter: { deletedAt: { attributeExists: false } },
    nextToken: nextToken ?? undefined,
    limit: RECORDS_PER_ADVANCE,
    ...inventoryAuthMode,
  });

  let attempted = 0;
  let generated = 0;

  for (const item of data) {
    const images: InventoryImageRecord[] = (item.images ?? [])
      .filter((img): img is NonNullable<typeof img> => Boolean(img))
      .map(normalizeImageRecord);
    if (images.every((img) => img.thumbnailKey)) continue; // the common case after the first few passes — nothing to do, no write

    let changed = false;
    const updatedImages = await Promise.all(
      images.map(async (img) => {
        if (img.thumbnailKey) return img;
        attempted++;
        const thumbnailKey = await generateInventoryThumbnail(img.storageKey);
        if (thumbnailKey) {
          generated++;
          changed = true;
        }
        return { ...img, thumbnailKey };
      }),
    );

    if (changed) {
      // Only the images field is touched — no history log entry (this is
      // system-driven optimization work, not a user-visible content
      // change, and logging one row per record here would just be noise
      // in every item's history — matching how ZAICO's own "unchanged"
      // path already writes nothing rather than logging a no-op).
      //
      // 第六ラウンドP0-5: この`.update()`呼び出しは意図的に`listUpdatedAt`
      // を設定しない — これがこのファイルの元々のコメント(このファイル
      // 冒頭、旧バージョン)が指摘していた「thumbnailKeyだけの内部更新が
      // Amplifyの自動updatedAtを"今"へ勝手に進め、ユーザーには見えない
      // 変更なのに一覧の並び順(updatedAt DESC)の先頭へ突然浮上する」
      // 不具合そのものへの根治的な修正である。listingPartition/
      // listUpdatedAt GSI(amplify/data/resource.tsのInventoryモデル
      // コメント、docs/inventory-cursor-pagination-20260830.md参照)は
      // Amplify自動updatedAtとは独立した明示フィールドなので、ここで
      // 触れない限り既存のlistUpdatedAt値がそのまま保たれ、バックフィル
      // によって一覧の並び順が乱れることはない。
      await serverDataClient.models.Inventory.update({ id: item.id, images: updatedImages }, inventoryAuthMode);
    }
  }

  return {
    scanned: data.length,
    attempted,
    generated,
    nextToken: nt ?? null,
    done: !nt,
  };
}
