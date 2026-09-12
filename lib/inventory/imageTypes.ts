/**
 * Phase C.5 — normal vs. damage/condition photos, and an explicit "top
 * image" concept, layered onto the existing `Inventory.images` field
 * without changing its shape at the GraphQL level (see amplify/data/
 * resource.ts's InventoryImage customType comment for the full
 * reasoning). Not `server-only`: read by server pages/actions AND the
 * client-side ImageEditor.
 *
 * Every function here is the ONE place that turns a raw, possibly-legacy
 * image object into a normalized one — nothing else in the app should
 * inspect `.type`/`.isPrimary` directly.
 */
export type InventoryImageType = "NORMAL" | "DAMAGE";
/** §7 BELLO画像自動加工システム(2026-08-30指示書)の画像分類。未設定(null)は defaultClassification (jobService.ts) が isPrimary/type から補完する。 */
export type ImageClassificationName = "TOP" | "FULL" | "DETAIL" | "DAMAGE" | "LABEL";

export interface InventoryImageRecord {
  storageKey: string;
  sortOrder: number;
  type: InventoryImageType;
  isPrimary: boolean;
  /** "ZAICO" for a photo the sync imported; null for anything BELLO added itself. The one thing the ZAICO sync uses to find "its" image among possibly several NORMAL photos, so it only ever replaces that one — see lib/inventory/zaicoSync.ts. */
  sourceSystem: string | null;
  /** ZAICO's `item_image.url` at the time this object was imported — compared on the next sync to skip re-downloading an unchanged photo. Meaningless (and always null) for a non-ZAICO image. */
  sourceUrl: string | null;
  /**
   * BELLO統合改修 master指示書 Phase B — a small (list-view-sized)
   * derivative of `storageKey`, generated once at upload/sync time (see
   * lib/inventory/thumbnail.ts) or via the ADMIN-triggered backfill
   * (lib/inventory/thumbnailBackfill.ts) for images uploaded before this
   * existed. null means "no thumbnail yet" — always fall back to
   * `storageKey` via `effectiveListThumbnailKey` below, never render a
   * broken image for it.
   */
  thumbnailKey: string | null;
  /**
   * 画像表示高速化・段階読込(P1、2026-09-12指示書) — `storageKey`
   * (原本)と`thumbnailKey`(一覧用320px)の間を埋める、長辺960px程度の
   * 派生画像のS3キー。詳細ページ/EC参照ギャラリーのメイン画像が
   * 「原本を先読みしない」ために最初に表示する版。生成できなかった/
   * まだ生成していない画像はnull — effectiveHeroKey(下記)がその場合
   * thumbnailKey→storageKeyの順にフォールバックするので、既存の全
   * レコード・生成に失敗した画像も表示自体は壊れない(劣化するのは
   * 速度だけ、thumbnailKeyと全く同じ安全側の設計)。生成はthumbnailKey
   * と同じ場所・同じタイミング(lib/inventory/thumbnail.tsのsharp)で
   * 一度だけ行う — 既存画像への遡及生成はこのラウンドでは行わない
   * (thumbnailKeyのbackfillと同じ仕組みを将来必要なら別途用意する)。
   */
  mediumKey: string | null;
  /**
   * BELLO画像自動加工システム(2026-08-30指示書)— アップロード時点の
   * オリジナルバイト列のSHA-256(lib/imageProcessing/pipeline.ts の
   * computeOriginalHash)。ProcessingJobの冪等性キー計算に使う。一度
   * 書いたら以後誰も書き換えない(workerもUIも)ので、既存のthumbnailKey
   * と違って「後から書き換わる」心配が無い、単純な追加専用フィールド。
   */
  originalHash: string | null;
  /** §7 画像分類。ユーザーが画像編集画面から明示的に設定する入力(isPrimaryと同じ位置づけ)——workerが書き込む出力ではない。未設定はnull。 */
  classification: ImageClassificationName | null;
}

/** Shape as it actually comes back from Amplify Data — `type`/`isPrimary`/`sourceSystem`/`sourceUrl`/`thumbnailKey` absent (null/undefined) on any row written before the field existed. */
export interface RawInventoryImage {
  storageKey: string;
  sortOrder: number;
  type?: string | null;
  isPrimary?: boolean | null;
  sourceSystem?: string | null;
  sourceUrl?: string | null;
  thumbnailKey?: string | null;
  mediumKey?: string | null;
  originalHash?: string | null;
  classification?: string | null;
}

/** Legacy image (no `type`) → NORMAL; anything else → whatever it says. This is the one and only migration rule this Phase relies on — no data is ever rewritten to add it. */
export function normalizeImageRecord(img: RawInventoryImage): InventoryImageRecord {
  return {
    storageKey: img.storageKey,
    sortOrder: img.sortOrder,
    type: img.type === "DAMAGE" ? "DAMAGE" : "NORMAL",
    isPrimary: img.isPrimary === true,
    sourceSystem: img.sourceSystem ?? null,
    sourceUrl: img.sourceUrl ?? null,
    thumbnailKey: img.thumbnailKey ?? null,
    mediumKey: img.mediumKey ?? null,
    originalHash: img.originalHash ?? null,
    classification: (img.classification as ImageClassificationName | undefined) ?? null,
  };
}

/** The key the list view should actually fetch for this image — its small thumbnail when one exists, the original otherwise (pre-backfill records, or a thumbnail generation failure that was swallowed at upload time — see thumbnail.ts). The detail page / gallery / edit preview must NEVER call this; they always use `storageKey` directly, by design (master指示書 Phase B: 詳細画面は高解像度のまま). */
export function effectiveListThumbnailKey(img: InventoryImageRecord): string {
  return img.thumbnailKey ?? img.storageKey;
}

/**
 * 画像表示高速化・段階読込(P1) — 詳細/EC参照ギャラリーの「メイン画像」
 * が拡大操作より前に表示すべきキー: mediumKey(960px)があればそれ、
 * 無ければthumbnailKey(320px、既存の一覧サムネイルと同じもの——多くの
 * 場合ユーザーが直前に一覧画面で見ていて既にsessionStorageへ署名済み
 * URLがキャッシュされている)、どちらも無ければ最後の手段としてのみ
 * storageKey(原本)——thumbnailKey同様、生成失敗/未生成のレコードでも
 * 表示自体は壊れないための安全側フォールバックであり、原本を先読み
 * しないという原則の例外はここだけ(かつ既存データにのみ発生する)。
 * `storageKey`(原本)は`InventoryImageGallery`が拡大操作時にだけ
 * 別途要求する — このヘルパーは絶対に原本を「積極的に選ぶ」ことは
 * ない、選ばれるのは他に何も無い場合だけ。
 */
export function effectiveHeroKey(img: InventoryImageRecord): string {
  return img.mediumKey ?? img.thumbnailKey ?? img.storageKey;
}

export function splitImagesByType(images: InventoryImageRecord[]): { normal: InventoryImageRecord[]; damage: InventoryImageRecord[] } {
  return {
    normal: images.filter((i) => i.type === "NORMAL").sort((a, b) => a.sortOrder - b.sortOrder),
    damage: images.filter((i) => i.type === "DAMAGE").sort((a, b) => a.sortOrder - b.sortOrder),
  };
}

/**
 * The single "which image represents this Inventory item" rule: an
 * explicit isPrimary among the NORMAL images wins; failing that, the
 * first NORMAL image by sortOrder — which is exactly the old "index 0 =
 * main image" behavior, so every record that predates Phase C.5 (no
 * isPrimary set on anything) keeps showing the same top image it always
 * did. A damage photo is never eligible, by construction (splitImagesByType
 * already excludes it before this ever looks at isPrimary).
 */
export function resolveTopImage(images: InventoryImageRecord[]): InventoryImageRecord | null {
  const { normal } = splitImagesByType(images);
  return normal.find((i) => i.isPrimary) ?? normal[0] ?? null;
}
