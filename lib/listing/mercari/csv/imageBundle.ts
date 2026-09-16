import "server-only";
import { listCsvImageDownloadTargets, resolveListingImageDownloadUrl } from "./buildExportRows";
import { MAX_ZIP_PRODUCTS, MAX_ZIP_IMAGES } from "./imageTransferLimits";

export { MAX_ZIP_PRODUCTS, MAX_ZIP_IMAGES } from "./imageTransferLimits";

/**
 * 画像まとめダウンロード(ZIP)の「計画」解決——署名URLの一覧だけを返す。
 *
 * ## 旧実装からの変更点と理由(task_f712cf24a9fe2308cd、2026-09-14是正)
 *
 * 旧実装(このファイルの`buildInventoryImageZip`)は、ここでサーバー側が
 * `fetch(署名URL)`→`arrayBuffer()`→ZIP組み立て→**base64化してServer
 * Actionの戻り値として返す**、という一連の処理を行っていた。実写真
 * (合計40MB=MAX_ZIP_TOTAL_BYTES)ではbase64化後に約53MBへ膨らみ、
 * AWS公式ドキュメントが明記する上限
 * (https://docs.aws.amazon.com/amplify/latest/userguide/troubleshooting-SSR.html
 * 「Currently, the maximum response size that Amplify supports for
 * Next.js 12 and later apps using the Web Compute platform is 5.72 MB.
 * Responses over that limit return 504 errors with no content to
 * clients.」)を最大9倍超過する。これは40MBという上限値の問題ではなく
 * 「画像バイトをこのSSR/Server Action経由で応答する」という設計そのもの
 * の限界——1枚の写真(数MB)を数枚束ねるだけでも5.72MBに達しうる。
 * fetch(url)自体にもタイムアウトが無く、`arrayBuffer()`で全量読み切って
 * からMAX_ZIP_FILE_BYTES判定していたため、取得中のメモリ・時間を
 * 有界にできていなかった。
 *
 * ## 新しい設計
 *
 * この関数はもう画像バイトを一切読まない。行うのはこれだけ:
 *   1. 商品数(MAX_ZIP_PRODUCTS)を事前に拒否
 *   2. `listCsvImageDownloadTargets`(既存、権限確認込みでinventoryId→
 *      下書き画像のstorageKey一覧を解決)で対象を確定
 *   3. 合計画像枚数(MAX_ZIP_IMAGES)を事前に拒否
 *   4. 各画像について`getInventoryImageDownloadUrl`(既存、S3署名URL・
 *      Content-Dispositionでファイル名固定済み)を発行
 *   5. {filename, url}の一覧(=数十件のURL文字列、数十KB程度)だけを返す
 *
 * 画像バイト自体は、この一覧を受け取ったブラウザが**S3から直接**
 * (このNext.jsサーバーを経由せず)取得し、ZIPもブラウザ側で組み立てる
 * (lib/listing/mercari/csv/browserImageZip.ts)。これによりServer
 * Actionの応答は常に「URL一覧」という小さいペイロードのままになり、
 * 5.72MB上限に触れる余地が無くなる——画像が何MBあってもこの応答サイズ
 * には影響しない。
 *
 * - storageKeyは常に`listCsvImageDownloadTargets`経由でのみ解決する
 *   ——クライアントから任意のURL/キーを受け取って解決することはしない
 *   (指示書「任意URL/キー入力を信用せず商品ID→権限確認→保存済み
 *   画像キー解決」、この方針は旧実装から変更していない)。
 * - 署名URLは短期(1時間)——恒久URLとしてCSVへ書き込まない、という
 *   方針も変更していない(getInventoryImageDownloadUrlのコメント参照)。
 * - 「1件でも失敗したら黙って隠さない」方針もここでは維持する:
 *   対象商品の解決(下書き未作成・画像0枚等)に失敗した場合はここで
 *   `ok:false`にする。画像バイト自体の取得失敗(期限切れ・通信断等)は
 *   この関数の責務の外——ブラウザ側(browserImageZip.ts)が同じ方針
 *   (1枚でも失敗したら部分成功のZIPを返さない)を引き継ぐ。
 */
export const ZIP_FILENAME_PREFIX = "mercari_shops_images_";

export interface ImageBundleFailure {
  inventoryId: string;
  displayId: string;
  reason: string;
}

export interface ImageZipPlanItem {
  inventoryId: string;
  displayId: string;
  filename: string;
  /** Amplify Storageの短期署名URL(既定1時間)。恒久URLではない。 */
  url: string;
}

export type ImageZipPlanResult =
  | { ok: true; filename: string; plan: ImageZipPlanItem[] }
  | { ok: false; reason: string; failures?: ImageBundleFailure[] };

export async function resolveInventoryImageZipPlan(inventoryIds: string[]): Promise<ImageZipPlanResult> {
  if (inventoryIds.length === 0) {
    return { ok: false, reason: "対象商品が0件です。1件以上選択してください" };
  }
  if (inventoryIds.length > MAX_ZIP_PRODUCTS) {
    return { ok: false, reason: `画像まとめダウンロードは一度に最大${MAX_ZIP_PRODUCTS}商品までです(選択${inventoryIds.length}件)` };
  }

  const failures: ImageBundleFailure[] = [];
  const targetsByInventory: {
    inventoryId: string;
    displayId: string;
    images: { filename: string; storageKey: string; source: "INVENTORY" | "PHOTO_ASSET" }[];
  }[] = [];

  for (const inventoryId of inventoryIds) {
    const targets = await listCsvImageDownloadTargets(inventoryId);
    if (!targets.ok) {
      failures.push({ inventoryId, displayId: inventoryId, reason: targets.reason });
      continue;
    }
    targetsByInventory.push({ inventoryId, displayId: targets.displayId, images: targets.images });
  }

  const totalImages = targetsByInventory.reduce((sum, t) => sum + t.images.length, 0);
  if (failures.length === 0 && totalImages > MAX_ZIP_IMAGES) {
    return { ok: false, reason: `画像まとめダウンロードは合計${MAX_ZIP_IMAGES}枚までです(対象${totalImages}枚)` };
  }
  if (failures.length > 0) {
    return { ok: false, reason: "一部商品の画像を取得できませんでした", failures };
  }

  const plan: ImageZipPlanItem[] = [];
  for (const target of targetsByInventory) {
    for (const img of target.images) {
      // resolveListingImageDownloadUrlは常にサーバー側で解決した参照のみを対象にする
      // (クライアント入力のキー/URLは一切経由しない)。ここではURLを発行するだけで、
      // 実際に取得しにいくのはブラウザ側(browserImageZip.ts)。
      const url = await resolveListingImageDownloadUrl(img, img.filename);
      if (!url) {
        return { ok: false, reason: `画像URLを取得できませんでした: ${target.displayId}/${img.filename}` };
      }
      plan.push({ inventoryId: target.inventoryId, displayId: target.displayId, filename: img.filename, url });
    }
  }

  const filename = `${ZIP_FILENAME_PREFIX}${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
  return { ok: true, filename, plan };
}
