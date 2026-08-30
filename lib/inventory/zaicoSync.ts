import "server-only";
import { getInventory, listInventories, type ZaicoInventory } from "@/lib/zaico/client";
import { mapZaicoCoreFields, mapZaicoOptionalAttributes } from "./zaicoMapping";
import { normalizeImageRecord, type InventoryImageRecord } from "./imageTypes";
import { diffField, type HistoryFieldChange } from "./history";
import { stringifyCustomFields, parseCustomFields } from "./customFieldsCodec";
import { ALL_EXTENDED_FIELDS } from "./extendedFields";
import { getServerSyncPort, type InventoryModel, type ZaicoSyncPort } from "./zaicoSyncPorts";

/**
 * The ZAICO→BELLO one-way sync engine (implementation instructions §1-39).
 * This file does NOT call ZAICO write endpoints (lib/zaico/client.ts has
 * none to call) and does NOT call the existing createInventory/
 * updateInventory Server Actions from app/actions/inventory.ts — those
 * `redirect()` on success, which is correct for a browser form submit
 * and wrong for a batch loop that needs to keep going across many items.
 *
 * BELLO統合改修 master指示書 Phase A (ZAICO background sync)で追加した
 * `port: ZaicoSyncPort`パラメータ(全公開関数、既定値は
 * `getServerSyncPort()` = 従来通りserverDataClient経由): このファイル
 * 自体はAWSクライアントを直接呼ばず、`zaicoSyncPorts.ts`が定義する
 * port経由でDynamoDB/AppSync/S3へアクセスする。既存の呼び出し元
 * (app/actions/zaicoSync.tsの1件/5件/全件同期、いずれもportを渡さない)
 * は既定値がそのまま従来の`serverDataClient`実装に解決されるため、
 * 挙動は一切変わらない(既にAWS上で動作確認済みの5件同期パスは無傷)。
 * 新設したチェックポイント方式のbackground batch同期
 * (lib/inventory/zaicoBackgroundSync.ts、app/actions/zaicoSync.tsの
 * advanceZaicoBackgroundSyncAction経由)も、同じ`syncOneZaicoItem`を
 * 同じデフォルトportで呼ぶだけで、mapping/dedup/diffロジックを一切複製
 * しない。zaicoSyncPorts.tsのファイル冒頭コメント参照 — 当初計画していた
 * 「EventBridgeで自律起動するLambda」経路は、Amplify Gen2の
 * `allow.resource(fn)`(model-level function resource authorization)が
 * @aws-amplify/data-schema@1.26.1(最新版)で未実装(パッケージ自身の
 * ソースに`TODO: delete when we make resource auth available at each
 * level in the schema`とある)であることを実際にビルド・実行して確認した
 * ため、今回は見送っている。
 *
 * ADMIN enforcement is NOT done here — it's the caller's job
 * (app/actions/zaicoSync.ts, for every sync path including the new
 * background-batch one), matching how every other Inventory server
 * check at the Server Action boundary, not buried in a shared lib
 * function.
 */

export interface ZaicoSyncItemResult {
  zaicoId: string;
  name: string;
  status: "created" | "updated" | "unchanged" | "failed";
  inventoryId?: string;
  sku?: string;
  imageImported: boolean;
  categoryCreated: boolean;
  locationCreated: boolean;
  warnings: string[];
  error?: string;
}

export interface ZaicoSyncResult {
  startedAt: string;
  finishedAt: string;
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  imageImported: number;
  categoryCreated: number;
  locationCreated: number;
  items: ZaicoSyncItemResult[];
}

interface ImageMergeResult {
  images: InventoryImageRecord[];
  imported: boolean;
  /** A newly-uploaded image's key — the caller removes this on a failed create/update (it was never actually attached to a saved record). */
  newStorageKey?: string;
  /** The newly-generated thumbnail's key (Phase B), if any — removed alongside newStorageKey on a failed create/update, same reasoning. */
  newThumbnailKey?: string | null;
  /** The image slot this replaced, if any — the caller removes this only AFTER a successful create/update, never before (see updateInventory's identical ordering in app/actions/inventory.ts: never delete an S3 object the DB might still end up pointing at if the write fails). */
  oldStorageKeyToRemove?: string;
  /** The replaced slot's thumbnail (Phase B), if any — removed alongside oldStorageKeyToRemove, same ordering. */
  oldThumbnailKeyToRemove?: string | null;
  warning?: string;
}

/**
 * Downloads+imports ZAICO's item_image.url only when it's actually new —
 * either there is no ZAICO image on this record yet, or the URL changed
 * since the image currently tagged sourceSystem:"ZAICO" was imported
 * (spec §16: unchanged URL ⇒ no re-download/re-upload). The new image
 * always becomes the top image (NORMAL, isPrimary, sortOrder 0 — spec
 * §17), and every BELLO-added NORMAL/DAMAGE photo is left completely
 * alone (spec: 同期でBELLO追加画像を削除しない) — only ever the ONE
 * slot tagged as ZAICO's own is ever replaced.
 */
async function mergeZaicoImage(existingImages: InventoryImageRecord[], newSourceUrl: string | null, port: ZaicoSyncPort): Promise<ImageMergeResult> {
  if (!newSourceUrl) {
    // AWSテスト環境構築指示 §16: ZAICO側の画像が消失(item_imageが
    // null/欠落)しても、BELLO側のS3画像を即削除しない — ここでは何も
    // 変更せず既存画像をそのまま維持する。ただし「検出」だけは行い、
    // 同期結果の警告として可視化する(実際にZAICO由来の画像を過去に
    // 取り込んでいた場合のみ — 元々ZAICO画像が無かった商品にまで警告
    // を出すと毎回のノイズになるため)。
    const hadZaicoImage = existingImages.some((i) => i.sourceSystem === "ZAICO");
    return {
      images: existingImages,
      imported: false,
      warning: hadZaicoImage
        ? "ZAICO側で画像URLが取得できませんでした(item_image消失の可能性)。BELLO側の既存画像は削除せずそのまま維持しています。"
        : undefined,
    };
  }

  const currentZaicoImage = existingImages.find((i) => i.sourceSystem === "ZAICO") ?? null;
  if (currentZaicoImage && currentZaicoImage.sourceUrl === newSourceUrl) {
    return { images: existingImages, imported: false };
  }

  let newKey: string;
  let newThumbnailKey: string | null;
  try {
    ({ storageKey: newKey, thumbnailKey: newThumbnailKey } = await port.downloadAndImportImage(newSourceUrl));
  } catch (err) {
    return { images: existingImages, imported: false, warning: err instanceof Error ? err.message : "ZAICO画像の取り込みに失敗しました。" };
  }

  const newRecord: InventoryImageRecord = {
    storageKey: newKey,
    sortOrder: 0,
    type: "NORMAL",
    isPrimary: true,
    sourceSystem: "ZAICO",
    sourceUrl: newSourceUrl,
    thumbnailKey: newThumbnailKey,
    // BELLO画像自動加工システム: ZAICO同期経路はoriginalHashを計算して
    // いない(downloadAndImportImageの契約を変えずに済ませるための、
    // このラウンドでの意図的な未対応範囲——完了報告の技術的負債へ記載)。
    // originalHashがnullの画像はlib/imageProcessing/jobService.tsの
    // triggerImageProcessingIfNeededが対象外として扱う(自動加工ジョブ
    // は作られない)ため、ZAICO由来の画像は現状、手動再加工UIからのみ
    // 加工対象にできる。
    originalHash: null,
    classification: null,
  };
  const otherImages = existingImages.filter((i) => i !== currentZaicoImage);
  const otherNormal = otherImages.filter((i) => i.type === "NORMAL").map((i) => ({ ...i, isPrimary: false }));
  const damage = otherImages.filter((i) => i.type === "DAMAGE");
  const renumberedNormal = otherNormal.map((img, idx) => ({ ...img, sortOrder: idx + 1 }));

  return {
    images: [newRecord, ...renumberedNormal, ...damage],
    imported: true,
    newStorageKey: newKey,
    newThumbnailKey,
    oldStorageKeyToRemove: currentZaicoImage?.storageKey,
    oldThumbnailKeyToRemove: currentZaicoImage?.thumbnailKey,
  };
}

/**
 * Syncs exactly one ZAICO item into BELLO — create if no BELLO record
 * carries this sourceInventoryId yet, update (ZAICO-authoritative fields
 * always overwritten) otherwise, or "unchanged" if nothing about it
 * actually differs. Never throws — every failure path is caught and
 * returned as `status: "failed"` with a human-readable `error`, so one
 * bad item can never take down a whole batch (spec: 部分的な失敗が全体
 * を止めないこと).
 *
 * `prefetched`, when given (full-catalog sync), skips the per-item
 * findExistingBySourceId lookup in favor of the one upfront scan.
 *
 * `port` (BELLO統合改修 master指示書 Phase A) — every AWS-touching
 * operation goes through this, defaulting to `getServerSyncPort()`
 * (byte-identical to this function's pre-refactor behavior). The
 * background sync worker (amplify/functions/zaico-sync-worker) passes
 * its own Lambda-side port instead — see zaicoSyncPorts.ts.
 */
export async function syncOneZaicoItem(
  zaicoItem: ZaicoInventory,
  who: string | null,
  prefetched?: Map<string, InventoryModel>,
  port: ZaicoSyncPort = getServerSyncPort(),
): Promise<ZaicoSyncItemResult> {
  const sourceInventoryId = String(zaicoItem.id);
  const warnings: string[] = [];
  let categoryCreated = false;
  let locationCreated = false;

  try {
    const existing = prefetched ? (prefetched.get(sourceInventoryId) ?? null) : await port.findExistingBySourceId(sourceInventoryId);
    const isNewRecord = existing === null;

    const { fields: core, warnings: coreWarnings } = mapZaicoCoreFields(zaicoItem);
    warnings.push(...coreWarnings);

    const optAttrs = mapZaicoOptionalAttributes(zaicoItem.optional_attributes, isNewRecord);
    warnings.push(...optAttrs.warnings);
    warnings.push(...optAttrs.unmapped.map((u) => `unmapped optional attribute: "${u.name}"`));

    // Category / Location: ZAICO is authoritative for a ZAICO-managed
    // item on every sync (spec §8/§9) — even if BELLO staff manually
    // changed it since the last sync, the next sync moves it back.
    let categoryId = existing?.categoryId ?? null;
    if (core.categoryName) {
      try {
        const r = await port.findOrCreateCategory(core.categoryName);
        categoryId = r.id;
        categoryCreated = r.created;
      } catch (err) {
        warnings.push(`カテゴリの同期に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    let locationId = existing?.locationId ?? null;
    if (core.locationName) {
      try {
        const r = await port.findOrCreateLocation(core.locationName);
        locationId = r.id;
        locationCreated = r.created;
      } catch (err) {
        warnings.push(`保管場所の同期に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      warnings.push("ZAICO側で保管場所(place)が取得できませんでした。保管場所は更新していません。");
    }

    const existingImages: InventoryImageRecord[] = (existing?.images ?? [])
      .filter((img): img is NonNullable<typeof img> => Boolean(img))
      .map(normalizeImageRecord);
    const imageMerge = await mergeZaicoImage(existingImages, core.imageSourceUrl, port);
    if (imageMerge.warning) warnings.push(imageMerge.warning);

    const existingCustomFields = parseCustomFields(existing?.customFields ?? null) ?? {};
    const mergedCustomFields = { ...existingCustomFields, ...optAttrs.customFields };

    // ── Diff against the existing record (skipped for a brand-new one —
    // everything about it is "new" by definition). Only the fields ZAICO
    // actually returned a usable value for this sync are diffed/written
    // — a field ZAICO didn't send a value for this time (null/absent)
    // leaves BELLO's existing value untouched rather than being zeroed
    // out, which is the conservative reading of "ZAICO由来フィールドは
    // 上書き" that avoids silently destroying data on a sparse response.
    const changes: HistoryFieldChange[] = [];
    if (!isNewRecord && existing) {
      const push = (c: HistoryFieldChange | null) => c && changes.push(c);
      push(diffField("商品名", existing.name, core.name));
      if (core.quantity !== null) push(diffField("数量", existing.quantity, core.quantity));
      if (core.unit !== null) push(diffField("単位", existing.unit, core.unit));
      if (core.note !== null) push(diffField("備考", existing.note, core.note));
      if (core.barcode !== null) push(diffField("QRコード・バーコード", existing.barcode, core.barcode));
      if (core.categoryName && categoryId !== (existing.categoryId ?? null)) {
        changes.push({ fieldName: "カテゴリ", oldValue: null, newValue: `${core.categoryName}（ZAICO同期）` });
      }
      if (core.locationName && locationId !== (existing.locationId ?? null)) {
        changes.push({ fieldName: "保管場所", oldValue: null, newValue: `${core.locationName}（ZAICO同期）` });
      }
      if (optAttrs.coreFields.purchasePrice !== undefined) push(diffField("購入価格", existing.purchasePrice, optAttrs.coreFields.purchasePrice));
      if (optAttrs.coreFields.salePrice !== undefined) push(diffField("販売価格", existing.salePrice, optAttrs.coreFields.salePrice));
      for (const [key, value] of Object.entries(optAttrs.extendedFields)) {
        const label = ALL_EXTENDED_FIELDS.find((f) => f.key === key)?.label ?? key;
        const oldValue = (existing as unknown as Record<string, unknown>)[key] as string | number | null | undefined;
        push(diffField(label, oldValue ?? null, value));
      }
      for (const [key, value] of Object.entries(optAttrs.customFields)) {
        push(diffField(key, (existingCustomFields[key] as string | number | null | undefined) ?? null, value));
      }
      if (imageMerge.imported) changes.push({ fieldName: "ZAICO画像", oldValue: null, newValue: "更新" });
    }

    if (!isNewRecord && existing && changes.length === 0) {
      // Nothing to write — the one thing that COULD have needed cleanup
      // (a downloaded-but-unused image) never happens here: mergeZaicoImage
      // only downloads when it detected an actual URL change, which
      // always produces a "ZAICO画像" change above.
      return {
        zaicoId: sourceInventoryId,
        name: core.name,
        status: "unchanged",
        inventoryId: existing.id,
        sku: existing.sku,
        imageImported: false,
        categoryCreated,
        locationCreated,
        warnings,
      };
    }

    if (isNewRecord) {
      let sku: string;
      try {
        sku = await port.generateSku();
      } catch (err) {
        if (imageMerge.newStorageKey) await port.removeImage(imageMerge.newStorageKey);
        if (imageMerge.newThumbnailKey) await port.removeImage(imageMerge.newThumbnailKey);
        throw err;
      }

      let created: InventoryModel;
      try {
        created = await port.createInventory({
          sku,
          name: core.name,
          categoryId: categoryId ?? undefined,
          locationId: locationId ?? undefined,
          quantity: core.quantity ?? 0,
          unit: core.unit ?? undefined,
          purchasePrice: optAttrs.coreFields.purchasePrice,
          salePrice: optAttrs.coreFields.salePrice,
          note: core.note ?? undefined,
          barcode: core.barcode ?? undefined,
          images: imageMerge.images,
          customFields: stringifyCustomFields(mergedCustomFields),
          createdBy: who ?? "ZAICO同期",
          updatedBy: who ?? "ZAICO同期",
          sourceSystem: "ZAICO",
          sourceInventoryId,
          extendedFields: optAttrs.extendedFields,
        });
      } catch (err) {
        if (imageMerge.newStorageKey) await port.removeImage(imageMerge.newStorageKey);
        if (imageMerge.newThumbnailKey) await port.removeImage(imageMerge.newThumbnailKey);
        throw err;
      }

      await port.logHistory(created.id, who, [
        { fieldName: "ZAICO同期", oldValue: null, newValue: `ZAICO ID ${sourceInventoryId} から新規作成 (SKU ${sku})` },
      ]);

      return {
        zaicoId: sourceInventoryId,
        name: core.name,
        status: "created",
        inventoryId: created.id,
        sku,
        imageImported: imageMerge.imported,
        categoryCreated,
        locationCreated,
        warnings,
      };
    }

    // existing !== null here (isNewRecord is false) — TypeScript can't
    // narrow that across the branches above, so assert it explicitly
    // rather than repeating the `existing &&` guard a third time.
    const existingRecord = existing!;
    try {
      await port.updateInventory({
        id: existingRecord.id,
        name: core.name,
        categoryId: categoryId ?? undefined,
        locationId: locationId ?? undefined,
        quantity: core.quantity !== null ? core.quantity : undefined,
        unit: core.unit !== null ? core.unit : undefined,
        note: core.note !== null ? core.note : undefined,
        barcode: core.barcode !== null ? core.barcode : undefined,
        purchasePrice: optAttrs.coreFields.purchasePrice,
        salePrice: optAttrs.coreFields.salePrice,
        images: imageMerge.images,
        customFields: stringifyCustomFields(mergedCustomFields),
        updatedBy: who ?? "ZAICO同期",
        extendedFields: optAttrs.extendedFields,
      });
    } catch (err) {
      if (imageMerge.newStorageKey) await port.removeImage(imageMerge.newStorageKey);
      if (imageMerge.newThumbnailKey) await port.removeImage(imageMerge.newThumbnailKey);
      throw err;
    }

    // Only now — after the write that (re)points the record at it has
    // actually succeeded — is the old ZAICO image slot's S3 object
    // removed. Best-effort: a failure here is logged inside
    // removeInventoryImage itself and never re-thrown.
    if (imageMerge.oldStorageKeyToRemove) await port.removeImage(imageMerge.oldStorageKeyToRemove);
    if (imageMerge.oldThumbnailKeyToRemove) await port.removeImage(imageMerge.oldThumbnailKeyToRemove);

    await port.logHistory(existingRecord.id, who, changes);

    return {
      zaicoId: sourceInventoryId,
      name: core.name,
      status: "updated",
      inventoryId: existingRecord.id,
      sku: existingRecord.sku,
      imageImported: imageMerge.imported,
      categoryCreated,
      locationCreated,
      warnings,
    };
  } catch (err) {
    return {
      zaicoId: sourceInventoryId,
      name: zaicoItem.title?.trim() || sourceInventoryId,
      status: "failed",
      imageImported: false,
      categoryCreated,
      locationCreated,
      warnings,
      error: err instanceof Error ? err.message : "不明なエラー",
    };
  }
}

function aggregateResult(startedAt: string, items: ZaicoSyncItemResult[]): ZaicoSyncResult {
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    total: items.length,
    created: items.filter((i) => i.status === "created").length,
    updated: items.filter((i) => i.status === "updated").length,
    unchanged: items.filter((i) => i.status === "unchanged").length,
    failed: items.filter((i) => i.status === "failed").length,
    imageImported: items.filter((i) => i.imageImported).length,
    categoryCreated: items.filter((i) => i.categoryCreated).length,
    locationCreated: items.filter((i) => i.locationCreated).length,
    items,
  };
}

/** The Phase 1 test path (spec §30-36): sync exactly one ZAICO item by its numeric id, and only that one. */
export async function syncSingleZaicoItem(zaicoId: string, who: string | null, port: ZaicoSyncPort = getServerSyncPort()): Promise<ZaicoSyncResult> {
  const startedAt = new Date().toISOString();
  const zaicoItem = await getInventory(zaicoId);
  const result = await syncOneZaicoItem(zaicoItem, who, undefined, port);
  return aggregateResult(startedAt, [result]);
}

/**
 * Full-catalog/limited-batch sync (spec §11、AWSテスト環境構築指示
 * §8/§9/§26で追加された安全なテストモード)。One upfront prefetch of
 * every ZAICO-managed BELLO record (fetchAllZaicoManagedInventory) plus
 * ZAICO's own paginated listing (lib/zaico/client.ts's listInventories,
 * throttled/retried internally) — a single blocking Server Action call,
 * deliberately not a Lambda/background-job architecture: at "a few
 * hundred records" scale, building queue/background-job infrastructure
 * ahead of that need would be over-engineering (spec's own instruction:
 * 過剰設計しないこと). Revisit this once the app is actually deployed
 * behind a request-timeout-bound host and the catalog grows much larger.
 *
 * `options.limit`(AWSテスト環境構築指示 §8: 「初期同期はデフォルトで
 * 全件にしない」)— 指定した場合、その件数に達した時点でZAICO側からの
 * 追加ページ取得も含めて即座に打ち切る。未指定(呼び出し元が明示的に
 * 全件同期を選んだ場合のみ)は既存どおり全件を対象にする — デフォルト
 * 引数ではなくoptional paramにしているのは、"うっかり省略したら全件"
 * ではなく呼び出し側(app/actions/zaicoSync.ts)の各Server Actionが
 * それぞれ明示的にlimitあり/なしを選ぶ形にするため。
 */
export async function syncAllZaicoItems(who: string | null, options: { limit?: number; port?: ZaicoSyncPort } = {}): Promise<ZaicoSyncResult> {
  const port = options.port ?? getServerSyncPort();
  const startedAt = new Date().toISOString();
  const prefetched = await port.fetchAllZaicoManaged();
  const items: ZaicoSyncItemResult[] = [];
  let page = 1;
  // ZAICO API pagination convention (page/per_page, "fewer than
  // requested ⇒ last page") is a best-effort assumption — see
  // lib/zaico/client.ts's listInventories comment; not re-confirmed
  // against a real multi-page response in this environment.
  outer: for (;;) {
    const { items: zaicoItems, hasMore } = await listInventories(page);
    for (const zaicoItem of zaicoItems) {
      items.push(await syncOneZaicoItem(zaicoItem, who, prefetched, port));
      if (options.limit !== undefined && items.length >= options.limit) break outer;
    }
    if (!hasMore) break;
    page += 1;
  }
  return aggregateResult(startedAt, items);
}

/**
 * 少数件テスト同期(AWSテスト環境構築指示 §8: 「初期：5〜10商品のみ」)
 * — syncAllZaicoItemsの薄いラッパー。全件同期(syncAllZaicoItems呼び出
 * し側でlimit省略)とは別の名前の関数として呼び出し元(app/actions/
 * zaicoSync.ts)から呼ばれることで、「limitを付け忘れて誤って全件同期
 * してしまう」事故を経路自体で防ぐ意図がある。
 */
export async function syncLimitedZaicoItems(limit: number, who: string | null): Promise<ZaicoSyncResult> {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 1, 50)); // 上限50 — テスト段階で誤って大量実行しないための安全弁
  return syncAllZaicoItems(who, { limit: safeLimit });
}

export interface ZaicoCatalogPreview {
  /** このページ(1ページ目)で実際に取得できた件数。 */
  sampleCount: number;
  /** ZAICO側にまだ次ページがあるかどうか — trueなら実際の総件数はsampleCountより多い。 */
  hasMore: boolean;
}

/**
 * ZAICO側の規模を「同期を実行せずに」確認するための軽量プレビュー
 * (AWSテスト環境構築指示 §8: 「実行前件数表示」)。ZAICOの一覧APIは
 * 総件数を返さない(lib/zaico/client.tsのlistInventories参照)ため、
 * 正確な総数ではなく「1ページ目の件数」と「まだ続きがあるか」だけを
 * 返す — 呼び出し側(UI)は「少なくともN件」「N件以上あります」という
 * 控えめな表現で表示し、実際には無い精度を装わない。
 */
export async function previewZaicoCatalogSize(): Promise<ZaicoCatalogPreview> {
  const { items, hasMore } = await listInventories(1);
  return { sampleCount: items.length, hasMore };
}
