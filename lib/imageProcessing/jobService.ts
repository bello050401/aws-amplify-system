import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import type { ImageClassificationName } from "@/lib/inventory/imageTypes";
import { ENGINE_VERSION } from "./sharpProcessor";
import { buildIdempotencyKey } from "./pipeline";

/** §7: 画像に明示的なclassificationが無い場合の既定値。DAMAGE写真は常にDAMAGE分類、NORMAL写真はisPrimary(=トップ画像候補)ならTOP、それ以外はFULL——「強い構図補正はTOP/FULLだけ」というsharpProcessor.tsの前提と一致させる。 */
export function defaultClassification(img: { type: "NORMAL" | "DAMAGE"; isPrimary: boolean; classification?: ImageClassificationName | null }): ImageClassificationName {
  if (img.classification) return img.classification;
  if (img.type === "DAMAGE") return "DAMAGE";
  return img.isPrimary ? "TOP" : "FULL";
}

/**
 * BELLO画像自動加工システム — ジョブ登録の唯一の入口。AWS(Amplify
 * Data)へアクセスする側なので"server-only"(pipeline.ts/types.tsは
 * 純粋ロジック/型のみでLambdaへもバンドルするため意図的にserver-only
 * を付けていない — lib/listing/pricing.ts vs pricingService.tsと同じ
 * 分離)。
 *
 * 呼び出し元:
 *  - app/actions/inventory.ts の updateInventory (§11.1 カテゴリ
 *    「撮影待ち」→「出品待ち」遷移トリガー、§11.2 出品待ち中の画像追加
 *    差分トリガー)
 *  - 将来のUI「再加工」ボタン(§12、MANUAL_REPROCESS)
 */

async function getActivePhotoProfileVersion(): Promise<number> {
  const { data } = await serverDataClient.models.PhotoProfile.list({
    filter: { active: { eq: true } },
    limit: 1,
    ...inventoryAuthMode,
  });
  return data[0]?.version ?? 0; // 0 = PhotoProfile未設定(§8.1のUIから基準写真登録前)。sharpProcessor側は既定のDEFAULT_ADJUSTMENTSで動作する。
}

/**
 * 既に同じidempotencyKeyを持つPENDING/PROCESSING行が無ければ
 * ProcessingJobを1件作成する(§11.4 冪等性 — カテゴリ往復・重複イベント
 * で同じ画像の重複ジョブが積み上がらない)。作成した場合はtrue、
 * 既存の未完了ジョブがあり何もしなかった場合はfalseを返す。
 */
export async function enqueueProcessingJob(input: {
  inventoryId: string;
  imageStorageKey: string;
  originalHash: string;
  triggerType: "CATEGORY_TRANSITION" | "NEW_IMAGE" | "MANUAL_REPROCESS";
  requestedAdjustments?: Record<string, unknown>;
}): Promise<boolean> {
  const photoProfileVersion = await getActivePhotoProfileVersion();
  const idempotencyKey = buildIdempotencyKey({
    storageKey: input.imageStorageKey,
    originalHash: input.originalHash,
    engineVersion: ENGINE_VERSION,
    photoProfileVersion,
    triggerType: input.triggerType,
    requestedAdjustments: input.requestedAdjustments,
  });

  // Scanの代わりにfilter付きlistで同一idempotencyKeyの未完了行を探す —
  // このテーブルの想定行数(商品1件あたり画像十数枚程度のジョブ)なら
  // 許容範囲(pricing-scheduler Lambda側のScanと違い、これはブラウザの
  // Server Action経由なので、件数が増えた場合はGSI追加を検討する旨を
  // 完了報告のコスト最適化候補へ記載する)。
  const { data: existingJobs } = await serverDataClient.models.ProcessingJob.list({
    filter: {
      and: [{ idempotencyKey: { eq: idempotencyKey } }, { or: [{ status: { eq: "PENDING" } }, { status: { eq: "PROCESSING" } }] }],
    },
    ...inventoryAuthMode,
  });
  if (existingJobs.length > 0) return false;

  const { errors } = await serverDataClient.models.ProcessingJob.create(
    {
      inventoryId: input.inventoryId,
      imageStorageKey: input.imageStorageKey,
      triggerType: input.triggerType,
      idempotencyKey,
      status: "PENDING",
      queuedAt: new Date().toISOString(),
      requestedAdjustments: input.requestedAdjustments ?? null,
    },
    inventoryAuthMode,
  );
  if (errors) throw new Error(`ProcessingJobの作成に失敗しました: ${JSON.stringify(errors)}`);
  return true;
}

/**
 * §11.1/§11.2 のトリガー本体。呼び出し元(updateInventory)は「更新前
 * のカテゴリ名/画像一覧」と「更新後のカテゴリ名/画像一覧」を渡すだけで
 * よく、実際の判定ロジックはここへ集約する(状態機械の定義を1箇所に
 * 保つ、という既存のstatus.ts/pricing.ts系の方針を踏襲)。
 */
export async function triggerImageProcessingIfNeeded(input: {
  inventoryId: string;
  oldCategoryName: string | null;
  newCategoryName: string | null;
  oldImageStorageKeys: string[];
  newImages: { storageKey: string; type: "NORMAL" | "DAMAGE"; originalHash?: string | null }[];
}): Promise<{ enqueuedCount: number }> {
  const normalize = (s: string | null) => (s ?? "").trim();
  const wasPhotographyPending = normalize(input.oldCategoryName) === "撮影待ち";
  const isListingPending = normalize(input.newCategoryName) === "出品待ち";
  const categoryJustTransitioned = wasPhotographyPending && isListingPending && normalize(input.oldCategoryName) !== normalize(input.newCategoryName);

  const oldKeys = new Set(input.oldImageStorageKeys);
  const addedImages = input.newImages.filter((img) => !oldKeys.has(img.storageKey) && img.type === "NORMAL");

  // §11.1: カテゴリがまさに今「撮影待ち」→「出品待ち」へ遷移した瞬間
  // だけ、その時点の全NORMAL画像(未処理のもの)をジョブ化する。
  // §11.2: 既に「出品待ち」の商品へ後から画像が追加された場合は、
  // その差分画像だけをジョブ化する(完成済み画像を巻き込まない、
  // 付録B「再加工で全画像を巻き込む処理」の禁止に対応)。
  const targets = categoryJustTransitioned
    ? input.newImages.filter((img) => img.type === "NORMAL")
    : isListingPending
      ? addedImages
      : [];

  let enqueuedCount = 0;
  for (const img of targets) {
    if (!img.originalHash) continue; // ハッシュ未計算(古い画像等)は対象外 — imageServerOps側で新規アップロード時に必ず計算する
    const created = await enqueueProcessingJob({
      inventoryId: input.inventoryId,
      imageStorageKey: img.storageKey,
      originalHash: img.originalHash,
      triggerType: categoryJustTransitioned ? "CATEGORY_TRANSITION" : "NEW_IMAGE",
    });
    if (created) enqueuedCount++;
  }
  return { enqueuedCount };
}

/**
 * その画像(imageStorageKey)の全バージョン、version昇順。schema側の
 * secondaryIndexes(index("imageStorageKey"))はDynamoDB上のGSIとしては
 * 実在するが、このリポジトリの既存コード(lib/listing/service.tsの
 * channelListingByInventoryId等)は生成されたper-index専用クエリ関数
 * ではなく`.list({filter})`を一貫して使っているため、ここでも同じ
 * 呼び出し方に揃える(呼び出し規約を1つに保つ——想定行数はこの画像の
 * 加工履歴のみなので、Scan相当のfilter付きlistでも許容範囲)。
 */
export async function listVersions(imageStorageKey: string) {
  const { data } = await serverDataClient.models.ImageProcessingVersion.list({
    filter: { imageStorageKey: { eq: imageStorageKey } },
    ...inventoryAuthMode,
  });
  return data.sort((a, b) => a.version - b.version);
}

/**
 * §12 バージョンrollback / workerが処理成功した新versionをACTIVEにする、
 * 両方の入口。旧ACTIVEを先にfalseへ落としてから新しい対象をtrueにする
 * ——常に「ACTIVEが0件の瞬間」を経由しても「ACTIVEが2件同時に存在する
 * 瞬間」は経由しない(表示側がfind(v=>v.active)で1件だけ拾う設計なら
 * 0件の瞬間はフォールバック——見つからなければ「処理中」表示でよく、
 * 2件同時存在の方が「どちらが正か不明」という実害があるため、この順序
 * を選んだ)。2回の独立UPDATE(id指定、GSIキー属性に触れない)なので
 * pricing-schedulerと同じ安全原則に従う。
 */
export async function setActiveVersion(imageStorageKey: string, newActiveVersionId: string): Promise<void> {
  const versions = await listVersions(imageStorageKey);
  const currentActive = versions.find((v) => v.active && v.id !== newActiveVersionId);
  if (currentActive) {
    await serverDataClient.models.ImageProcessingVersion.update({ id: currentActive.id, active: false, status: "SUPERSEDED" }, inventoryAuthMode);
  }
  await serverDataClient.models.ImageProcessingVersion.update({ id: newActiveVersionId, active: true }, inventoryAuthMode);
}

/**
 * 「要確認」の加工結果を人が見たうえで採用する(§17)。
 *
 * ## なぜ必要だったか
 *
 * workerは`active: status === "READY"`でしかACTIVEにしない。そして
 * 被写体セグメンテーションが未実装の間はcompositionConfidenceが常に0で、
 * 判定は**必ずNEEDS_REVIEWへ倒れる**(pipeline.tsに明記のとおり、意図的な
 * 安全側動作)。
 *
 * つまりこの関数が無い状態では、workerがmaster/web/サムネイルを生成して
 * S3とDBへ残しても、**ACTIVEになる経路が1つも存在しなかった**。実機で
 * 16件の加工結果が出来ていたが、画面からは加工前/加工後の比較すら
 * 開けず(比較UIはREADYのときだけ描画)、採用するボタンも無く、
 * 生成物が完全に到達不能だった。
 *
 * 「要確認」は"人が見て決める"という意味なので、決める手段を用意する。
 * 自動でREADYにするのではなく、**人が押したときだけ**READY+ACTIVEにする
 * — 安全側の判定そのものは変えない。
 */
export async function adoptVersion(imageStorageKey: string, versionId: string): Promise<void> {
  await setActiveVersion(imageStorageKey, versionId);
  // 人の確認が済んだのでREADYへ。setActiveVersionが旧ACTIVEを
  // SUPERSEDEDへ落とした後に実行する(順序を入れ替えるとSUPERSEDED側を
  // READYへ戻してしまう)。
  await serverDataClient.models.ImageProcessingVersion.update({ id: versionId, status: "READY" }, inventoryAuthMode);
}
