import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { listAllPages } from "@/lib/amplify/listAll";
import type { Schema } from "@/amplify/data/resource";
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
  // ★ ここを1ページだけ読むと、**冪等性が壊れる方向**へ倒れる。
  //
  // 既存の未完了ジョブを見つけられなければ「無い」と判断して新しい
  // ジョブを作ってしまう —— 同じ画像に対する重複ジョブが積み上がる。
  // 取りこぼしが「何もしない」ではなく「余計に作る」に化けるので、
  // 他の箇所より実害が大きい。
  const existingJobs = await listAllPages<{ id: string }>(
    async (nextToken) => {
      const res = await serverDataClient.models.ProcessingJob.list({
        filter: {
          and: [{ idempotencyKey: { eq: idempotencyKey } }, { or: [{ status: { eq: "PENDING" } }, { status: { eq: "PROCESSING" } }] }],
        },
        limit: 200,
        nextToken,
        ...inventoryAuthMode,
      });
      return { data: res.data as unknown as { id: string }[], nextToken: res.nextToken, errors: res.errors };
    },
    { label: "画像加工ジョブ(重複確認)" },
  );
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
 * 2026-08-31ユーザー実機フィードバック対応: 「個々の写真の『加工する』を
 * 押しても何の反応もない」の根本原因への対処。`ImageProcessingVersion`
 * は加工が実際に完了して初めて1行できるため、5分毎起動のworkerが
 * まだ拾っていない間(押した直後〜最大5分)は、画面側にその「予約は
 * 済んでいる」という情報が一切無く、押していないのと区別が付かな
 * かった。ProcessingJob(status PENDING/PROCESSING)の存在を
 * imageStorageKeyごとに引けるようにし、ImageProcessingPanel.tsxが
 * ImageProcessingVersionが無い間もQUEUED/PROCESSING表示を出せるように
 * する。
 *
 * ProcessingJobはsecondaryIndexesを持たない設計(schema側コメント参照
 * ——workerのstatus Scanのみを想定していた)ため、ここでのimageStorageKey
 * 指定は実質Scan+FilterExpressionになる。listVersionsと同じ理由
 * (想定行数はこの商品の画像加工履歴程度)で許容するが、ProcessingJob
 * 全体の行数が増えてきた場合はsecondaryIndexes追加を検討すること。
 */
export async function listPendingJobStatuses(imageStorageKeys: string[]): Promise<Record<string, "PENDING" | "PROCESSING">> {
  if (imageStorageKeys.length === 0) return {};
  // ★ Limit-before-Filter の再発防止(2026-09-02)。
  //
  // DynamoDBの Limit は**フィルタ適用前に読む件数**の上限。filter付きの
  // list を1ページだけ読むと、条件に合う行が他に何件あっても返らない。
  // image-processing-worker が5分ごとに「0 pending job(s)」と言い続けて
  // いたのと同じ不具合で、あちらは修正済みだが**画面側の同じ読み方は
  // 残っていた**。ProcessingJob は完了済みの行が積み上がるテーブルなので、
  // 行数が増えるほど確実に踏む。
  const data = await listAllPages<{ imageStorageKey: string; status: string }>(
    async (nextToken) => {
      const res = await serverDataClient.models.ProcessingJob.list({
        filter: {
          and: [
            { or: imageStorageKeys.map((k) => ({ imageStorageKey: { eq: k } })) },
            { or: [{ status: { eq: "PENDING" } }, { status: { eq: "PROCESSING" } }] },
          ],
        },
        limit: 200,
        nextToken,
        ...inventoryAuthMode,
      });
      return { data: res.data as unknown as { imageStorageKey: string; status: string }[], nextToken: res.nextToken, errors: res.errors };
    },
    { label: "画像加工ジョブ" },
  );
  const result: Record<string, "PENDING" | "PROCESSING"> = {};
  for (const job of data) {
    // 同じ画像に複数の未完了ジョブが理論上あっても(通常は起きない —
    // enqueueProcessingJob自体が同一idempotencyKeyの重複を防ぐ)、
    // PROCESSINGの方がより進んだ状態として優先表示する。
    if (job.status === "PROCESSING" || result[job.imageStorageKey] === undefined) {
      result[job.imageStorageKey] = job.status as "PENDING" | "PROCESSING";
    }
  }
  return result;
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
  // 同上 —— ImageProcessingVersion も追記専用で増え続けるテーブル。
  // 1ページだけ読むと、版が増えたある日から**加工済みの画像が画面に
  // 出なくなる**(「未加工」と表示される)。件数が少ないうちは動いて
  // 見えるので、増えてから気づくことになる。
  // 版の行そのものの型。Amplify の list の戻り値から引くと条件型が
  // 深くなりすぎて tsc が止まるので、Schema から直接取る。
  type VersionRow = Schema["ImageProcessingVersion"]["type"];
  const data = await listAllPages<VersionRow>(
    async (nextToken) => {
      const res = await serverDataClient.models.ImageProcessingVersion.list({
        filter: { imageStorageKey: { eq: imageStorageKey } },
        limit: 200,
        nextToken,
        ...inventoryAuthMode,
      });
      return { data: res.data as unknown as VersionRow[], nextToken: res.nextToken, errors: res.errors };
    },
    { label: "画像加工の版" },
  );
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
