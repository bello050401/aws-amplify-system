import "server-only";
import { cookies, headers } from "next/headers";
import { getUrl } from "aws-amplify/storage/server";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { runWithAmplifyServerContext } from "@/lib/amplify/serverUtils";
import { getInventoryDetail } from "@/lib/inventory/queries";
import { isE2EFixtureModeActive } from "@/lib/inventory/e2eFixtures";
import { getListingDraftForInventory, getChannelListing } from "@/lib/listing/service";
import type { ListingImageRef } from "@/lib/listing/types";
import { PHOTO_REGISTRATION_REGION } from "@/lib/photoRegistration/types";
import { isMercariImgE2EKey, mercariImgE2EVariant } from "./e2eImageFixtureBytes";
import { assembleMercariCsvRowFields, imageFilename } from "./assembleRow";
import type { RowBuildResult } from "./assembleRow";

export { DEFAULT_SHIPPING_ORIGIN_AREA } from "./assembleRow";
export type { RowBuildSuccess, RowBuildFailure, RowBuildResult } from "./assembleRow";

/**
 * 実DB(Inventory/ListingDraft/ChannelListing)から1商品分を取得し、
 * `assembleMercariCsvRowFields`(純粋関数、外部I/Oなし)へ渡してMercari
 * Shops CSVの論理フィールドを組み立てる。判定ロジック自体は
 * assembleRow.tsに切り出してある(合成fixtureでの単体検証のため)。
 */
export async function buildExportRowForInventory(inventoryId: string): Promise<RowBuildResult> {
  const inventory = await getInventoryDetail(inventoryId);
  if (!inventory) {
    return { ok: false, inventoryId, displayId: inventoryId, reasons: ["商品が見つかりません(削除済みの可能性があります)"] };
  }

  const draft = await getListingDraftForInventory(inventoryId);
  if (!draft) {
    return {
      ok: false,
      inventoryId,
      displayId: inventory.displayId,
      reasons: ["EC出品下書きが未作成です。先に出品下書きを作成し、タイトル/説明/価格/状態/画像を設定してください"],
    };
  }

  const channelListing = await getChannelListing(inventoryId, "MERCARI_SHOPS");

  return assembleMercariCsvRowFields(
    inventoryId,
    { displayId: inventory.displayId, quantity: inventory.quantity, sku: inventory.sku, barcode: inventory.barcode ?? null },
    draft,
    channelListing,
  );
}

/** 画像を人がMercari側へ手動アップロードするための一時ダウンロードURLを発行する。
 * 自前のS3バケットに対してAmplify Storage SDK経由で署名URLを作るだけ
 * (任意の外部URLを取得するわけではないためSSRF対策は不要——対象は
 * 常に自バケット内の既知のstorageKeyのみ)。短期署名URLであり恒久URLで
 * はない旨をUI側で明示すること。
 *
 * `downloadFilename`を渡すと、S3の`ResponseContentDisposition`
 * (Amplify Storageの`options.contentDisposition`)でCSVと同じ
 * `imageFilename()`の値を強制する——ブラウザのcross-origin
 * リンク表示(target=_blank)は保存時のファイル名を保証しないため
 * (S3側のオブジェクトキーやUUID由来の名前で保存され得る)、
 * ここでサーバー側からContent-Dispositionを明示し、CSVの
 * 商品画像名列と手元に保存される実ファイル名を必ず一致させる。 */
export async function getInventoryImageDownloadUrl(storageKey: string, downloadFilename?: string): Promise<string> {
  // Mercari CSV画像受渡しE2E(2026-09-14レビュー修正)専用の分岐——
  // lib/inventory/e2eFixtures.tsと同じ二重ゲート(isE2EFixtureModeActive)
  // の内側でのみ、`e2e-mercari-img:`接頭辞のstorageKeyを実Amplify
  // Storageではなくローカルのe2e-fixtures配信route(app/e2e-fixtures/
  // mercari-image/[variant]/route.ts)へ差し替える。imageBundle.tsが
  // 実際にこのURLへ`fetch()`するため、実AWSに一切到達せずに「サーバー
  // 側で本当にHTTP経由の画像バイト取得が行われる」経路をE2Eで検証できる
  // (lib/listing/mercari/csv/e2eImageFixtureBytes.tsのコメント参照)。
  // headers()で受信リクエストのhostをそのまま使う——next devのポートを
  // 決め打ちしない(playwright.config.tsは3100を使うが、環境変数を増やさず
  // 既存の「サーバー自身が受けたリクエストのhost」から絶対URLを組み立てる)。
  if (isE2EFixtureModeActive() && isMercariImgE2EKey(storageKey)) {
    const h = await headers();
    const host = h.get("host") ?? "127.0.0.1:3100";
    const proto = host.startsWith("127.0.0.1") || host.startsWith("localhost") ? "http" : "https";
    return `${proto}://${host}/e2e-fixtures/mercari-image/${mercariImgE2EVariant(storageKey)}`;
  }

  const { url } = await runWithAmplifyServerContext({
    nextServerContext: { cookies },
    operation: (contextSpec) =>
      getUrl(contextSpec, {
        path: storageKey,
        options: {
          expiresIn: 3600,
          ...(downloadFilename ? { contentDisposition: { type: "attachment", filename: downloadFilename } } : {}),
        },
      }),
  });
  return url.toString();
}

/**
 * PhotoAsset(撮影画像)由来の出品画像は自社Storageの別バケット
 * (PHOTO_REGISTRATION_BUCKET_NAME、lib/photoRegistration/webAdapter.ts
 * のreadRuntimeConfigFromEnvと同じ3変数)に置かれており、Amplify Storage
 * (Inventory用バケット)経由では解決できない。lib/photoRegistration/
 * webAdapter.ts自体はこのタスクの変更対象外でPhotoAsset向け署名GETを
 * 公開していないため、CSV/ZIPダウンロード専用にここで同じfail closed
 * 規約でS3Clientだけを組み立てる(DynamoDB/repositoryは不要——S3キーは
 * 既にListingImageRef.storageKeyとして解決済み)。
 */
let cachedPhotoAssetS3: { client: S3Client; bucket: string } | null | undefined;

function getPhotoAssetS3Runtime(): { client: S3Client; bucket: string } | null {
  if (cachedPhotoAssetS3 !== undefined) return cachedPhotoAssetS3;
  const tableName = process.env.PHOTO_REGISTRATION_TABLE_NAME;
  const inventoryTableName = process.env.PHOTO_REGISTRATION_INVENTORY_TABLE_NAME;
  const bucketName = process.env.PHOTO_REGISTRATION_BUCKET_NAME;
  if (!tableName || !inventoryTableName || !bucketName) {
    cachedPhotoAssetS3 = null;
    return null;
  }
  const region = process.env.PHOTO_REGISTRATION_AWS_REGION || PHOTO_REGISTRATION_REGION;
  cachedPhotoAssetS3 = { client: new S3Client({ region }), bucket: bucketName };
  return cachedPhotoAssetS3;
}

/** RFC 6266のfilename*(UTF-8)付きContent-Disposition。ASCII側は`"`/改行だけ潰した簡易フォールバック。 */
function contentDispositionHeader(filename: string): string {
  const asciiFallback = filename.replace(/["\r\n]/g, "_");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function getPhotoAssetDownloadUrl(storageKey: string, downloadFilename?: string): Promise<string | null> {
  const runtime = getPhotoAssetS3Runtime();
  if (!runtime) return null;
  const command = new GetObjectCommand({
    Bucket: runtime.bucket,
    Key: storageKey,
    ...(downloadFilename ? { ResponseContentDisposition: contentDispositionHeader(downloadFilename) } : {}),
  });
  try {
    return await getSignedUrl(runtime.client, command, { expiresIn: 3600 });
  } catch (error) {
    console.error("[buildExportRows] getPhotoAssetDownloadUrl failed", { storageKey, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * `img.source`未設定(旧データ)はINVENTORYとして扱う
 * (lib/listing/types.tsのListingImageRefコメントと同じ規約)。
 */
function listingImageSource(ref: ListingImageRef): "INVENTORY" | "PHOTO_ASSET" {
  return ref.source === "PHOTO_ASSET" ? "PHOTO_ASSET" : "INVENTORY";
}

/**
 * 1件の出品画像のダウンロードURLを、保存元(source)に応じて解決する。
 * INVENTORY(既存Inventory画像)は従来どおりAmplify Storage、PHOTO_ASSET
 * (撮影画像)はphoto registration用S3を使う——storageKeyの見た目だけで
 * どちらのバケットか推測しない(保存元を混同しない)。環境未接続で
 * 解決できない場合はnull(fail closed、呼び出し側で失敗として扱う)。
 */
export async function resolveListingImageDownloadUrl(
  image: { storageKey: string; source?: "INVENTORY" | "PHOTO_ASSET" },
  downloadFilename?: string,
): Promise<string | null> {
  if (image.source === "PHOTO_ASSET") return getPhotoAssetDownloadUrl(image.storageKey, downloadFilename);
  return getInventoryImageDownloadUrl(image.storageKey, downloadFilename);
}

/**
 * CSV生成用に組み立てた画像ファイル名と、それに対応する下書き画像の
 * storageKey/保存元の対応表を返す(署名URL発行前の一覧表示用)。
 *
 * 画像受渡し導線(指示書§4「既存BASE画像URL優先、次点で
 * getInventoryImageDownloadUrlの署名URL」)について: このtaskでは
 * BASE側の確定した画像URLとInventoryの1:1紐付けをDB上で保証する
 * フィールドが存在しない(lib/inquiry/baseProductLookup.tsの
 * BASE商品照合は「アーカイブ/API」からの検索結果であり、商品名類似の
 * 混入を許さない確定リンクではない——指示書が禁じる「商品名類似だけの
 * 結合」に該当しうるため、このtaskでは自動採用しない)。そのため
 * 「次点」である自社S3署名URL方式のみを実装し、BASE画像URL優先の
 * 自動解決は次工程へ送る(完了報告に明記)。
 *
 * PhotoAsset(撮影画像)由来の画像が1件でも含まれる場合、photo
 * registrationのS3接続(fail closed)が未設定なら全体をng扱いにする
 * ——一部の画像だけ欠けたダウンロードリンク一覧を黙って返さない。
 */
export async function listCsvImageDownloadTargets(
  inventoryId: string,
): Promise<
  | { ok: true; displayId: string; images: { filename: string; storageKey: string; source: "INVENTORY" | "PHOTO_ASSET" }[] }
  | { ok: false; reason: string }
> {
  const inventory = await getInventoryDetail(inventoryId);
  if (!inventory) return { ok: false, reason: "商品が見つかりません(削除済みの可能性があります)" };
  const draft = await getListingDraftForInventory(inventoryId);
  if (!draft) return { ok: false, reason: "EC出品下書きが未作成です" };
  if (draft.images.length === 0) return { ok: false, reason: "下書きに画像がありません" };

  const sorted = draft.images.slice().sort((a, b) => a.sortOrder - b.sortOrder);
  const hasPhotoAsset = sorted.some((img) => listingImageSource(img) === "PHOTO_ASSET");
  if (hasPhotoAsset && !getPhotoAssetS3Runtime()) {
    return { ok: false, reason: "撮影画像(PhotoAsset)のダウンロードには画像登録基盤への接続が必要です(未接続のため取得できません)" };
  }

  const images = sorted.map((img, idx) => ({
    filename: imageFilename(img.storageKey, inventory.displayId, idx),
    storageKey: img.storageKey,
    source: listingImageSource(img),
  }));

  return { ok: true, displayId: inventory.displayId, images };
}
