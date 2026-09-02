import { randomUUID } from "node:crypto";
import { mapZaicoCoreFields, mapZaicoOptionalAttributes } from "./zaicoMapping";
import { mergeZaicoUpdate, labelOf, type MergeMode } from "./zaicoSyncMerge";
import { normalizeImageRecord, type InventoryImageRecord } from "./imageTypes";
import { ALL_EXTENDED_FIELDS } from "./extendedFields";
import type { InventoryModel, ZaicoSyncPort, MasterCache } from "./zaicoSyncPorts";
import type { ZaicoInventory } from "@/lib/zaico/client";

/**
 * BELLO統合業務OS 第五ラウンド §4(P0-A): ZAICO同期エンジンの本体
 * (`syncOneZaicoItem`とその内部ヘルパー)を`lib/inventory/zaicoSync.ts`
 * から切り出した、意図的に**`server-only`を持たない**ファイル。
 *
 * 【切り出した理由】`zaicoSync.ts`はファイル冒頭で`import "server-only"`
 * しているため(`lib/zaico/client.ts`が必要——`syncSingleZaicoItem`/
 * `syncAllZaicoItems`がZAICO APIを直接呼ぶため)、そのファイルから
 * `syncOneZaicoItem`だけをLambda(`amplify/functions/zaico-sync-worker/`)
 * へbundleしようとしても、モジュール全体の評価時に`server-only`パッケー
 * ジが無条件でthrowし、Lambda cold start時にクラッシュする
 * (`server-only`はreact-server export conditionでのみ許可される
 * no-opへ解決される仕組みで、Next.jsのbundler以外——生Node実行環境や
 * esbuildによるLambda bundleを含む——では常に本物のthrowになる)。
 *
 * しかし`syncOneZaicoItem`自身のロジックは元々AWS/Next.js依存を一切
 * 持たない(全てのAWS操作は`port: ZaicoSyncPort`経由)——実際に
 * server-onlyを引きずり込んでいたのは、`zaicoSync.ts`が同じファイル内
 * で(`syncOneZaicoItem`とは無関係な)`getInventory`/`listInventories`
 * (`lib/zaico/client.ts`)を直接importしていたことと、
 * `diffField`/`stringifyCustomFields`/`parseCustomFields`/
 * `normalizeMasterName`という4つの**純粋関数**がserver-onlyな
 * ファイル(`history.ts`/`customFieldsCodec.ts`/`masters.ts`)に同居して
 * いたことだけが原因だった。
 *
 * 【対応方針、正直に】上記4つの純粋関数は「小さな重複を許容し、誤った
 * 依存結合を避ける」という、このリポジトリで既に確立された方針
 * (`lib/zaico/secretStore.ts` vs `lib/listing/mercari/secretStore.ts`、
 * `lib/imageProcessing/sharpProcessor.ts`のTHUMBNAIL_MAX_DIMENSION等)
 * をそのまま踏襲し、このファイル内へ複製する(元のロジックをコピー
 * するだけで、business logicの再実装ではない——値・分岐は一字一句
 * 同じ)。`mapZaicoCoreFields`/`mapZaicoOptionalAttributes`/
 * `normalizeImageRecord`/`ALL_EXTENDED_FIELDS`はどれも元から
 * server-onlyではないため、そのままimportして再利用する(複製しない)。
 *
 * `lib/inventory/zaicoSync.ts`はこのファイルの全exportをそのまま
 * re-exportし、既存のServer Action呼び出し元(app/actions/zaicoSync.ts
 * 等)への影響はゼロ(import pathも変更不要)。
 */

// ── history.tsから複製した純粋関数(diffField/normalize) ──────────────
export interface HistoryFieldChange {
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
}

function normalizeHistoryValue(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

/**
 * claim の解放を試み、**失敗しても元のエラーを握りつぶさない**。
 *
 * 解放が失敗するとその在庫IDは「リンクはあるがInventoryが無い」不整合に
 * なり、以後の同期で毎回 throw される——つまりその1件は二度と取り込め
 * なくなる。実際に ZAICO ID 48824174 がこの状態で取り残されていた。
 *
 * とはいえ、ここで解放の失敗を投げ直すと**本来の失敗原因**(SKU採番、
 * create失敗など)が失われて調査できなくなる。両方を残すため、解放の
 * 失敗は元のエラーのメッセージへ追記する形にする。
 */
async function releaseClaimPreservingError(
  port: ZaicoSyncPort,
  sourceInventoryId: string,
  originalError: unknown,
): Promise<unknown> {
  try {
    await port.releaseSourceLink(sourceInventoryId);
    return originalError;
  } catch (releaseErr) {
    const original = originalError instanceof Error ? originalError.message : String(originalError);
    const release = releaseErr instanceof Error ? releaseErr.message : String(releaseErr);
    const combined = new Error(
      `${original} / さらに重複防止リンクの解放にも失敗しました(この在庫IDは手動修復が必要です): ${release}`,
    );
    if (originalError instanceof Error && originalError.stack) combined.stack = originalError.stack;
    return combined;
  }
}

export function diffField(fieldName: string, oldValue: string | number | null | undefined, newValue: string | number | null | undefined): HistoryFieldChange | null {
  const oldNorm = normalizeHistoryValue(oldValue);
  const newNorm = normalizeHistoryValue(newValue);
  if (oldNorm === newNorm) return null;
  return { fieldName, oldValue: oldNorm, newValue: newNorm };
}

// ── customFieldsCodec.tsから複製した純粋関数 ──────────────────────────
export function stringifyCustomFields(fields: Record<string, unknown> | null | undefined): string | undefined {
  if (!fields || Object.keys(fields).length === 0) return undefined;
  return JSON.stringify(fields);
}

export function parseCustomFields(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      console.error("[Inventory.customFields] failed to JSON.parse stored value:", raw, err);
      return null;
    }
  }
  return raw as Record<string, unknown>;
}

// ── masters.tsから複製した純粋関数 ────────────────────────────────────
export function normalizeMasterName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * 不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §11: `ZaicoSourceLink`
 * (amplify/data/resource.tsのモデルコメント参照)の主キー`id`を組み立てる
 * 純粋関数。Next.js側(zaicoSyncPorts.ts)とLambda側
 * (amplify/functions/zaico-sync-worker/lambdaSyncPort.ts、生DynamoDB)
 * の両方の`ZaicoSyncPort`実装がこれを共有することで、どちらの経路で
 * claimしても同じ`id`に収束する(=同じsourceInventoryIdなら必ず同じ
 * 行を奪い合う)ことを保証する——1箇所だけ別の組み立て方をすると、
 * この一意性保証自体が意味を成さなくなるため、複製せず共有必須。
 */
export function buildZaicoSourceLinkId(sourceSystem: string, sourceInventoryId: string): string {
  return `${sourceSystem}#${sourceInventoryId}`;
}

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

interface ImageMergeResult {
  images: InventoryImageRecord[];
  imported: boolean;
  newStorageKey?: string;
  newThumbnailKey?: string | null;
  oldStorageKeyToRemove?: string;
  oldThumbnailKeyToRemove?: string | null;
  warning?: string;
}

/** lib/inventory/zaicoSync.tsのmergeZaicoImageと同一(移動しただけ)。 */
async function mergeZaicoImage(existingImages: InventoryImageRecord[], newSourceUrl: string | null, port: ZaicoSyncPort): Promise<ImageMergeResult> {
  if (!newSourceUrl) {
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
  let newOriginalHash: string;
  try {
    ({ storageKey: newKey, thumbnailKey: newThumbnailKey, originalHash: newOriginalHash } = await port.downloadAndImportImage(newSourceUrl));
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
    originalHash: newOriginalHash,
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

async function findOrCreateCategoryCached(name: string, port: ZaicoSyncPort, cache?: MasterCache): Promise<{ id: string; created: boolean }> {
  if (!cache) return port.findOrCreateCategory(name);
  const key = normalizeMasterName(name);
  const hit = cache.categories.get(key);
  if (hit) return { id: hit.id, created: false };
  const result = await port.findOrCreateCategory(name);
  cache.categories.set(key, { id: result.id });
  return result;
}

async function findOrCreateLocationCached(name: string, port: ZaicoSyncPort, cache?: MasterCache): Promise<{ id: string; created: boolean }> {
  if (!cache) return port.findOrCreateLocation(name);
  const key = normalizeMasterName(name);
  const hit = cache.locations.get(key);
  if (hit) return { id: hit.id, created: false };
  const result = await port.findOrCreateLocation(name);
  cache.locations.set(key, { id: result.id });
  return result;
}

/**
 * ZAICO 1件をBELLOへ同期する本体。lib/inventory/zaicoSync.tsの
 * (移動前の)同名関数と一字一句同じロジック——AWS/Next.js非依存、
 * `port`経由でのみ外界へアクセスする。Next.js側(Server Action)からも
 * Lambda(amplify/functions/zaico-sync-worker)からも、それぞれの
 * `ZaicoSyncPort`実装を渡して同じこの関数を呼ぶ(mapping/dedup/diff
 * ロジックの完全な単一化——§4「既存実装を作り直さない」)。
 */
/**
 * ZAICOの1件をBELLOへ反映する。
 *
 * ── mode: "SNAPSHOT_ONLY" (C案の初回基準づくり) ──────────────────
 *
 * **既存の在庫の業務値を1つも書き換えない。** ZAICOの現在値を
 * 3-way判定の基準(zaicoSnapshotJson)として記録するだけ。その時点で
 * 食い違っていた項目は warnings に「確認してください」として並ぶ。
 *
 * 新規作成(BELLOにまだ無いZAICO商品)はこのモードでも従来どおり作る。
 * 基準を作る対象がそもそも存在しないし、新規作成に人の編集は無いため。
 *
 * 省略時は "MERGE"。既存の呼び出しは何も変わらない。
 */
export async function syncOneZaicoItem(
  zaicoItem: ZaicoInventory,
  who: string | null,
  prefetched: Map<string, InventoryModel> | undefined,
  port: ZaicoSyncPort,
  masterCache?: MasterCache,
  mode: MergeMode = "MERGE",
): Promise<ZaicoSyncItemResult> {
  const sourceInventoryId = String(zaicoItem.id);
  const warnings: string[] = [];
  let categoryCreated = false;
  let locationCreated = false;

  try {
    let existing = prefetched ? (prefetched.get(sourceInventoryId) ?? null) : await port.findExistingBySourceId(sourceInventoryId);
    let isNewRecord = existing === null;

    // 不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §11.7:
    // 「検索して無ければcreate」というアプリ側の判定だけでは、直前の
    // findExistingBySourceId呼び出しの後・実際のInventory.create()の前に
    // 別の同期(同時実行/二重クリック/resumeとretryの重複起動)が同じ
    // sourceInventoryIdを既にcreate済みだった場合、二重作成され得る
    // (実データで確認されたZAICO在庫ID重複の実害候補の1つ)。
    //
    // 新規作成と判定した時点で、実際にInventoryを作る前にこの
    // sourceInventoryIdをDB層で原子的にclaimする——`port.claimSourceLink`
    // はAmplifyのcreateミューテーションが標準で行う条件付き書き込み
    // (対象idが未存在の場合のみ成功)を利用しており、同じ
    // sourceInventoryIdに対して2箇所が同時にclaimしようとしても片方
    // しか成功しない。claimに失敗した側は「自分より先に誰かが本当に
    // このsourceInventoryIdを保持している」ことが確定するので、新規
    // 作成をやめてその既存レコードへのupdate経路へ安全に切り替える
    // ——これによりcreate自体は決して2回実行されない。
    let claimedInventoryId: string | null = null;
    if (isNewRecord) {
      claimedInventoryId = randomUUID();
      const claim = await port.claimSourceLink(sourceInventoryId, claimedInventoryId);
      if (!claim.claimed) {
        claimedInventoryId = null;
        // claim済みの行が指す実際のInventoryを取り直す——findExistingBySourceId
        // はリンクが存在すればO(1)のget経由でこれを見つけられる(ここでは
        // 必ずリンクが存在する状態になっているため、直前の呼び出しがまだ
        // リンクを見ていなかった場合でも今度は確実に見つかる)。
        existing = await port.findExistingBySourceId(sourceInventoryId);
        isNewRecord = existing === null;
        if (isNewRecord) {
          // 理論上到達しないはずの経路(claim失敗=既に誰かがこの
          // sourceInventoryIdを保持しているはずなのに、そのInventory
          // レコード自体が見つからない——リンクだけが残った不整合な
          // 状態、例えば以前のcreate失敗時に補償削除が失敗した場合等)。
          // 安全側に倒し、詳細なエラーを返して手動確認を促す
          // (「不整合なまま強引に作り直す」ことはしない)。
          throw new Error(
            `ZAICO在庫ID ${sourceInventoryId} の重複防止リンクは存在しますが、参照先のInventoryレコードが見つかりません(不整合な状態です)。管理者による確認が必要です。`,
          );
        }
      }
    }

    const { fields: core, warnings: coreWarnings } = mapZaicoCoreFields(zaicoItem);
    warnings.push(...coreWarnings);

    const optAttrs = mapZaicoOptionalAttributes(zaicoItem.optional_attributes, isNewRecord);
    warnings.push(...optAttrs.warnings);
    warnings.push(...optAttrs.unmapped.map((u) => `unmapped optional attribute: "${u.name}"`));

    let categoryId = existing?.categoryId ?? null;
    if (core.categoryName) {
      try {
        const r = await findOrCreateCategoryCached(core.categoryName, port, masterCache);
        categoryId = r.id;
        categoryCreated = r.created;
      } catch (err) {
        warnings.push(`カテゴリの同期に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    let locationId = existing?.locationId ?? null;
    if (core.locationName) {
      try {
        const r = await findOrCreateLocationCached(core.locationName, port, masterCache);
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

    // ── ZAICOが「何か言ってきているか」だけを見る生の差分 ──────────
    //
    // これは**早期returnの判定にしか使わない**。ここで作った差分をその
    // まま履歴へ書くと、更新方針(mergeZaicoUpdate)が「人の編集を守って
    // 書き込まなかった」項目まで「変更した」と記録してしまう。
    // 履歴は実際に書き込んだものだけを載せる —— 下の appliedChanges。
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

    // 基準作成モードでは、生の差分が無くてもスナップショットを書く必要が
    // あるので早期returnしない(基準がまだ1件も無いのが今回の出発点)。
    if (mode === "MERGE" && !isNewRecord && existing && changes.length === 0) {
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
      const inventoryId = claimedInventoryId!; // isNewRecord===trueの場合、上のclaim処理で必ず設定済み
      let sku: string;
      try {
        sku = await port.generateSku();
      } catch (err) {
        if (imageMerge.newStorageKey) await port.removeImage(imageMerge.newStorageKey);
        if (imageMerge.newThumbnailKey) await port.removeImage(imageMerge.newThumbnailKey);
        // claim済みロックを解放——次回の再試行が「既に誰かが保持している」と誤判定しないようにする
        throw await releaseClaimPreservingError(port, sourceInventoryId, err);
      }

      let created: InventoryModel;
      try {
        created = await port.createInventory({
          id: inventoryId, // claimSourceLinkで既に予約済みのidをそのまま使う(ZaicoSyncJobの単一行idと同じ「明示id指定create」パターン)
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
        // 同上——create自体が失敗した場合もclaimを解放し、再試行を妨げない
        throw await releaseClaimPreservingError(port, sourceInventoryId, err);
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

    const existingRecord = existing!;

    // ── 項目別の更新方針を適用する(2026-09-02) ────────────────────
    //
    // 以前はここで全項目を無条件に上書きしていた。その結果、人が
    // 「発送完了 → 補修待ち」へ戻した判断を42分後の同期が差し戻す、
    // という事故が実データで2件起きていた(lib/inventory/
    // zaicoUpdatePolicy.ts の冒頭に履歴を引用してある)。
    //
    // いまは前回ZAICOが渡した値をスナップショットとして持ち、
    //   BELLOの現在値 === 前回のZAICO値 → 誰も触っていない → 更新可
    //   BELLOの現在値 !== 前回のZAICO値 → 人が変えた       → 方針に従う
    // で判定する。
    const merge = mergeZaicoUpdate({
      zaico: {
        categoryId: categoryId ?? undefined,
        locationId: locationId ?? undefined,
        name: core.name,
        quantity: core.quantity ?? undefined,
        unit: core.unit ?? undefined,
        note: core.note ?? undefined,
        barcode: core.barcode ?? undefined,
        purchasePrice: optAttrs.coreFields.purchasePrice,
        salePrice: optAttrs.coreFields.salePrice,
        extendedFields: optAttrs.extendedFields as Record<string, unknown>,
        customFields: optAttrs.customFields as Record<string, unknown>,
      },
      bello: {
        categoryId: existingRecord.categoryId ?? null,
        locationId: existingRecord.locationId ?? null,
        name: existingRecord.name,
        quantity: existingRecord.quantity ?? null,
        unit: existingRecord.unit ?? null,
        note: existingRecord.note ?? null,
        barcode: existingRecord.barcode ?? null,
        purchasePrice: existingRecord.purchasePrice ?? null,
        salePrice: existingRecord.salePrice ?? null,
        extendedFields: existingRecord as unknown as Record<string, unknown>,
        customFields: existingCustomFields,
      },
      snapshotJson: (existingRecord as unknown as { zaicoSnapshotJson?: string | null }).zaicoSnapshotJson ?? null,
      isNewRecord: false,
      mode,
    });

    // 最後の歯止め。SNAPSHOT_ONLY で業務値が入っていたら、そこはバグ
    // なので処理を続けない —— 「基準を作るだけ」と言って業務値を書き
    // 換えるのが、この設計で一番やってはいけないこと。
    if (!merge.writesBusinessValues) {
      const wouldWrite = [...Object.keys(merge.updates), ...Object.keys(merge.extendedFields)];
      if (wouldWrite.length > 0) {
        throw new Error(`基準作成モードで業務値を書き込もうとしました(項目: ${wouldWrite.join(", ")})。処理を中止します。`);
      }
    }

    // 人の編集を守って据え置いた項目・自動判断しない食い違いは、黙って
    // 落とさず必ず報告へ載せる。「同期したのに変わっていない」を
    // 利用者が自分で調べる羽目にならないようにする。
    for (const s of merge.skipped) {
      warnings.push(`${s.label}: ZAICOの値を反映しませんでした(${s.reason})`);
    }
    // 基準作成モードで見つかった食い違い。据え置きでも競合でもなく、
    // 「基準を作った時点でずれていた」という事実の一覧。
    for (const d of merge.baselineDifferences) {
      warnings.push(
        `${d.label}: BELLO「${String(d.belloValue)}」/ ZAICO「${String(d.zaicoValue)}」(基準作成時点の相違。値は変更していません)`,
      );
    }
    for (const c of merge.conflicts) {
      warnings.push(
        `${c.label}: BELLO「${String(c.belloValue)}」とZAICO「${String(c.zaicoValue)}」が食い違っています。` +
          `どちらが正しいか確認してください(自動では変更していません)。`,
      );
    }

    // ── 履歴は「実際に書き込んだもの」だけ ──────────────────────
    //
    // 上の `changes` はZAICOとBELLOの生の差分で、mergeが据え置いた項目も
    // 含んでいる。それを履歴にすると、人が「発送完了 → 補修待ち」へ
    // 戻した判断を守れている場合でも、履歴には
    //
    //     ステータス: 補修待ち → 発送完了（ZAICO同期）
    //
    // と残る —— **実際に起きた差し戻し事故と全く同じ見え方**になる。
    // この履歴は、その事故を突き止めるのに使った証跡そのものなので、
    // 嘘が混じると次に何かあったときに追えなくなる。
    const appliedChanges: HistoryFieldChange[] = [];
    for (const [key, value] of Object.entries(merge.updates)) {
      const before = (existingRecord as unknown as Record<string, unknown>)[key];
      const c = diffField(labelOf(key), before as string | number | null | undefined, value as string | number | null | undefined);
      if (c) appliedChanges.push(c);
    }
    for (const [key, value] of Object.entries(merge.extendedFields)) {
      const label = ALL_EXTENDED_FIELDS.find((f) => f.key === key)?.label ?? labelOf(key);
      const before = (existingRecord as unknown as Record<string, unknown>)[key];
      const c = diffField(label, before as string | number | null | undefined, value as string | number | null | undefined);
      if (c) appliedChanges.push(c);
    }
    for (const [key, value] of Object.entries(merge.customFields)) {
      const before = existingCustomFields[key] as string | number | null | undefined;
      const c = diffField(key, before ?? null, value as string | number | null | undefined);
      if (c) appliedChanges.push(c);
    }
    if (imageMerge.imported) appliedChanges.push({ fieldName: "ZAICO画像", oldValue: null, newValue: "更新" });

    try {
      await port.updateInventory({
        id: existingRecord.id,
        ...merge.updates,
        images: imageMerge.images,
        customFields: stringifyCustomFields(merge.customFields),
        updatedBy: who ?? "ZAICO同期",
        extendedFields: merge.extendedFields,
        zaicoSnapshotJson: merge.nextSnapshotJson,
      });
    } catch (err) {
      if (imageMerge.newStorageKey) await port.removeImage(imageMerge.newStorageKey);
      if (imageMerge.newThumbnailKey) await port.removeImage(imageMerge.newThumbnailKey);
      throw err;
    }

    if (imageMerge.oldStorageKeyToRemove) await port.removeImage(imageMerge.oldStorageKeyToRemove);
    if (imageMerge.oldThumbnailKeyToRemove) await port.removeImage(imageMerge.oldThumbnailKeyToRemove);

    // 基準作成モードでは業務値を書いていないので、履歴に残すことは何も
    // 無い。空配列を渡せば logInventoryHistory 側が何もしないが、意図を
    // 明示しておく(履歴は「実際に書き込んだもの」だけ、という原則)。
    await port.logHistory(existingRecord.id, who, merge.writesBusinessValues ? appliedChanges : []);

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
