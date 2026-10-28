"use server";
import { randomUUID, createHash } from "node:crypto";
import { cookies } from "next/headers";
import { uploadData } from "aws-amplify/storage/server";
import { runWithAmplifyServerContext } from "@/lib/amplify/serverUtils";
import {
  canEditInventory,
  getInventoryRole,
  getCurrentInventoryUserEmail,
} from "@/lib/amplify/requireInventoryUser";
import { purchaseGmailReader } from "@/lib/saleCandidates/mailReader";
import {
  listAllInventory,
  listCategories,
  listLocations,
} from "@/lib/inventory/queries";
import { getInventoryRaw } from "@/lib/inventory/categoryPersistence";
import { removeInventoryImage } from "@/lib/inventory/imageServerOps";
import { createInventory } from "./inventory";
import {
  getImportRecord,
  putImportRecord,
  claimImport,
  releaseImport,
} from "@/lib/procurement/store";
import { resolveRestageDefaults } from "@/lib/procurement/restageLedger";
import { classifyItem } from "@/lib/procurement/restage";
import { procurementLedgerDetails } from "@/lib/procurement/ledgerDetails";
import { defaultYahooPurchaseRange } from "@/lib/procurement/yahooRange";
import { yahooPurchaseUnitPrice } from "@/lib/procurement/yahooAmounts";
import {
  parseYahooPurchaseMail,
  isYahooPurchaseNotice,
  consolidateYahooPurchases,
  yahooPurchaseQuery,
  yahooPurchaseId,
  normalizeProcurementTitle,
  auctionIdValid,
  type YahooPurchaseEvent,
  type YahooPurchase,
} from "@/lib/procurement/yahoo";
import {
  yahooPublicItem,
  yahooStore,
  yahooImage,
  type YahooStore,
} from "@/lib/procurement/yahooPublic";

async function actor() {
  if (!canEditInventory(await getInventoryRole()))
    throw Error("定期仕入れの操作権限がありません。");
  const who = await getCurrentInventoryUserEmail();
  if (!who) throw Error("ログインし直してください。");
  return who;
}
function message(e: unknown) {
  const m = e instanceof Error ? e.message : "";
  return m === "GMAIL_RATE_LIMIT"
    ? "Gmailの一時的な取得制限です。少し待って「取得を続ける」を押してください。"
    : m === "GMAIL_AUTH_REQUIRED"
      ? "Gmailの再接続が必要です。売却管理の「Gmail再接続」から接続してください。"
      : /^(?:取得|登録|商品|写真|ストア|ヤフオク|定期|数量|金額|送料|同じ|古物|最新|別の|ログイン)/.test(
            m,
          )
        ? m
        : "処理結果を確認できません。もう一度取得すると重複せず確認できます。";
}
async function run(id: string) {
  const who = await actor();
  if (!/^[0-9a-f-]{36}$/.test(id)) throw Error("取得結果が不正です。");
  const r = await getImportRecord("YAHOO_RUN#" + id, "STATE");
  if (!r || r.createdBy !== who || r.ttl < Date.now() / 1000)
    throw Error("取得結果の有効期限が切れました。再取得してください。");
  return r;
}
export async function startYahooProcurementAction(from?: string, to?: string) {
  await actor();
  try {
    if (from === undefined && to === undefined) {
      ({ from, to } = defaultYahooPurchaseRange());
    }
    if (!from || !to) throw Error("取得期間の開始日と終了日を選んでください。");
    const query = yahooPurchaseQuery(from, to),
      reader = await purchaseGmailReader(),
      ids: string[] = [];
    let page: string | undefined;
    do {
      const found = await reader.list(query, page);
      ids.push(...(found.messages || []).map((m: { id: string }) => m.id));
      page = found.nextPageToken;
      if (ids.length > 200)
        throw Error("取得対象の通知が多すぎます。期間を短くしてください。");
    } while (page);
    const id = randomUUID();
    await putImportRecord({
      pk: "YAHOO_RUN#" + id,
      sk: "STATE",
      from,
      to,
      ids: [...new Set(ids)],
      index: 0,
      events: [],
      createdBy: await actor(),
      ttl: Math.floor(Date.now() / 1000) + 86400,
    });
    return { ok: true as const, runId: id, count: ids.length, from, to };
  } catch (e) {
    return { ok: false as const, error: message(e) };
  }
}
export async function readYahooProcurementAction(id: string) {
  await run(id);
  const pk = "YAHOO_RUN#" + id,
    owner = await claimImport(pk, "STATE", 120);
  if (!owner) return { ok: false as const, error: "別の画面で取得中です。" };
  try {
    const r = await run(id);
    const reader = await purchaseGmailReader(),
      events = [...r.events] as YahooPurchaseEvent[];
    let index = Number(r.index),
      unrecognized = Number(r.unrecognized || 0);
    for (let n = 0; n < 2 && index < r.ids.length; n++, index++) {
      const mail = await reader.read(r.ids[index]),
        event = parseYahooPurchaseMail(mail);
      if (event) events.push(event);
      else if (isYahooPurchaseNotice(mail.subject)) unrecognized++;
    }
    await releaseImport(pk, "STATE", owner, { events, index, unrecognized });
    return {
      ok: true as const,
      done: index >= r.ids.length,
      checked: index,
      total: r.ids.length,
    };
  } catch (e) {
    await releaseImport(pk, "STATE", owner);
    return { ok: false as const, error: message(e) };
  }
}
export type YahooProcurementRow = YahooPurchase & {
  inventoryId: string | null;
  alreadyImported?: boolean;
  excluded?: boolean;
  possibleDuplicates: { id: string; name: string }[];
  imageUrl?: string;
  storeInfo?: YahooStore | null;
  sourceReady?: boolean;
  error?: string;
};
type PurchaseAmounts = { quantity: number; itemTotal: number; shipping: number };
function purchaseAmounts(value: unknown): PurchaseAmounts | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as PurchaseAmounts;
  if ([v.quantity, v.itemTotal, v.shipping].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 2147483647)
    && v.quantity >= 1 && v.quantity <= 10000 && v.itemTotal + v.shipping <= 2147483647)
    return { quantity: v.quantity, itemTotal: v.itemTotal, shipping: v.shipping };
}
export async function previewYahooProcurementAction(id: string) {
  const r = await run(id);
  try {
    if (r.index < r.ids.length) throw Error("取得が完了していません。");
    const lots = consolidateYahooPurchases(r.events, r.from, r.to),
      existing = await listAllInventory(),
      [categories, locations] = await Promise.all([
        listCategories(),
        listLocations(),
      ]),
      defaults = resolveRestageDefaults(categories, locations);
    const rows: YahooProcurementRow[] = [];
    for (const lot of lots) {
      const previous = await getImportRecord("YAHOO_PURCHASE", lot.auctionId);
      const exact = existing.filter(
        (e) =>
          (e.customFields?.__yahooPurchaseImport &&
            (e.customFields.__yahooPurchaseImport as { auctionId?: string })
              .auctionId === lot.auctionId) ||
          new RegExp(
            "(?:^|[^a-z0-9])" + lot.auctionId + "(?:$|[^a-z0-9])",
            "i",
          ).test(e.adminMemo || ""),
      );
      // Splitting/duplicating an inventory item may preserve its purchase ID.
      // Any match means this purchase must not create another inventory item.
      const alreadyImported = previous?.status === "REGISTERED" || exact.length > 0;
      const origin = exact.find(e => e.id === previous?.inventoryId)
        || exact.find(e => e.id === yahooPurchaseId(lot.auctionId));
      const confirmedPurchase = purchaseAmounts(previous?.confirmedPurchase)
        || purchaseAmounts(origin?.customFields?.__yahooPurchaseImport)
        || (exact.length === 1 ? purchaseAmounts(exact[0].customFields?.__yahooPurchaseImport) : undefined);
      const row: YahooProcurementRow = {
        ...lot,
        alreadyImported,
        excluded: previous?.status === "EXCLUDED",
        inventoryId:
          previous?.status === "REGISTERED"
            ? String(previous.inventoryId)
            : exact.length === 1
              ? exact[0].id
              : null,
        possibleDuplicates: existing
          .filter(
            (e) =>
              normalizeProcurementTitle(e.name) ===
              normalizeProcurementTitle(lot.name),
          )
          .map((e) => ({ id: e.id, name: e.name })),
      };
      rows.push(row);
      const key = { pk: "YAHOO_RUN#" + id, sk: "LOT#" + lot.auctionId };
      if (!(await getImportRecord(key.pk, key.sk)))
        await putImportRecord({
          ...key,
          lot: row,
          confirmedPurchase,
          defaults,
          ttl: r.ttl,
          createdBy: r.createdBy,
        });
    }
    return {
      ok: true as const,
      rows: rows.filter((row) => !row.excluded && !row.alreadyImported),
      importedCount: rows.filter((row) => !row.excluded && row.alreadyImported).length,
      excludedCount: rows.filter((row) => row.excluded).length,
      unrecognized: Number(r.unrecognized || 0),
    };
  } catch (e) {
    return { ok: false as const, error: message(e) };
  }
}
export async function prepareYahooProcurementPhotoAction(
  id: string,
  auctionId: string,
) {
  const r = await run(id);
  try {
    if (!auctionIdValid(auctionId)) throw Error("商品IDが不正です。");
    const pk = "YAHOO_RUN#" + id,
      sk = "LOT#" + auctionId,
      record = await getImportRecord(pk, sk);
    if (!record) throw Error("取得結果がありません。");
    if (record.sourceReady)
      return {
        ok: true as const,
        imageUrl: String(record.imageUrl),
        storeInfo: record.storeInfo as YahooStore | null,
        date: String(record.lot.date),
      };
    const item = await yahooPublicItem(auctionId),
      lot = record.lot as YahooProcurementRow;
    if (
      normalizeProcurementTitle(item.name) !==
      normalizeProcurementTitle(lot.name)
    )
      throw Error("商品のタイトルと写真の取得元が一致しません。");
    if (lot.store && !item.storeUrl)
      throw Error("ストア情報を確認できません。");
    const storeInfo = item.storeUrl ? await yahooStore(item.storeUrl) : null;
    const date = item.date || lot.date;
    if (date < r.from || date > r.to)
      throw Error("商品の落札日が指定期間外です。取得期間を確認してください。");
    const owner = await claimImport(pk, sk);
    if (!owner) throw Error("別の画面で取得中です。");
    await releaseImport(pk, sk, owner, {
      sourceReady: true,
      imageUrl: item.imageUrl,
      storeInfo,
      lot: { ...lot, date },
    });
    return { ok: true as const, imageUrl: item.imageUrl, storeInfo, date };
  } catch (e) {
    return { ok: false as const, error: message(e) };
  }
}
export type YahooPurchaseConfirmation = {
  auctionId: string;
  quantity: number;
  itemTotal: number;
  shipping: number;
  amountConfirmed: boolean;
  distinctConfirmed: boolean;
};
/** Hide a purchase candidate permanently without deleting any inventory or photo. */
export async function excludeYahooProcurementAction(id: string, auctionId: string, amounts: PurchaseAmounts) {
  const r = await run(id);
  try {
    if (!auctionIdValid(auctionId)) throw Error("商品IDが不正です。");
    const member = await getImportRecord("YAHOO_RUN#" + id, "LOT#" + auctionId);
    if (!member) throw Error("取得結果がありません。");
    if (member.lot.alreadyImported || member.lot.inventoryId) throw Error("登録済みの商品は候補から削除できません。");
    const pk = "YAHOO_PURCHASE", previous = await getImportRecord(pk, auctionId);
    if (previous?.status === "EXCLUDED") return { ok: true as const };
    if (previous?.status === "REGISTERED") throw Error("登録済みの商品は候補から削除できません。再取得してください。");
    const owner = await claimImport(pk, auctionId);
    if (!owner) throw Error("登録中です。再取得で結果を確認してください。");
    try {
      // Keep the confirmed purchase amounts for another item in the same order's ledger.
      await releaseImport(pk, auctionId, owner, {
        status: "EXCLUDED", exclusionReason: "USER_DISMISSED",
        excludedAt: new Date().toISOString(), excludedBy: r.createdBy,
        confirmedPurchase: purchaseAmounts(amounts) ?? null,
      });
    } catch (e) { await releaseImport(pk, auctionId, owner); throw e; }
    return { ok: true as const };
  } catch (e) { return { ok: false as const, error: message(e) }; }
}
export async function registerYahooProcurementAction(
  id: string,
  auctionId: string,
  confirmation: YahooPurchaseConfirmation[],
) {
  const r = await run(id);
  try {
    if (
      !auctionIdValid(auctionId) ||
      !Array.isArray(confirmation) ||
      confirmation.length > 200 ||
      new Set(confirmation.map((x) => x.auctionId)).size !== confirmation.length
    )
      throw Error("登録内容が不正です。");
    const preview = await getImportRecord(
      "YAHOO_RUN#" + id,
      "LOT#" + auctionId,
    );
    if (!preview || !preview.sourceReady)
      throw Error("写真・ストア情報を取得してください。");
    const lot = preview.lot as YahooProcurementRow;
    const previous = await getImportRecord("YAHOO_PURCHASE", auctionId);
    if (previous?.status === "EXCLUDED")
      throw Error("登録対象から除外された商品です。");
    if (previous?.status === "REGISTERED" || lot.inventoryId)
      return {
        ok: true as const,
        inventoryId: String(previous?.inventoryId || lot.inventoryId),
        skipped: true,
      };
    if (lot.alreadyImported) throw Error("登録済みの商品です。再取得してください。");
    const group = consolidateYahooPurchases(r.events, r.from, r.to).filter(
        (x) =>
          lot.orderId ? x.orderId === lot.orderId : x.auctionId === auctionId,
      ),
      details = await Promise.all(group.map(async (source) => {
        // Previously imported members of a combined order stay hidden in the UI.
        // Reuse their original confirmed amounts, never their current split stock.
        const saved = await getImportRecord("YAHOO_PURCHASE", source.auctionId);
        const member = await getImportRecord("YAHOO_RUN#" + id, "LOT#" + source.auctionId);
        const imported = saved?.status === "REGISTERED" || member?.lot?.alreadyImported || saved?.exclusionReason === "USER_DISMISSED";
        const amounts = imported
          ? purchaseAmounts(saved?.confirmedPurchase) || purchaseAmounts(member?.confirmedPurchase)
          : undefined;
        if (imported && !amounts) throw Error("同じ注文の登録済み商品の購入金額を確認できません。既存の商品を確認してください。");
        const v = amounts
          ? { ...amounts, auctionId: source.auctionId, amountConfirmed: true, distinctConfirmed: false }
          : confirmation.find((v) => v.auctionId === source.auctionId);
        if (!v || !v.amountConfirmed)
          throw Error("最新の商品合計・送料・数量を確認してください。");
        if (
          ![v.quantity, v.itemTotal, v.shipping].every(
            (n) => Number.isSafeInteger(n) && n >= 0 && n <= 2147483647,
          ) ||
          v.quantity < 1 ||
          v.quantity > 10000 ||
          v.itemTotal + v.shipping > 2147483647
        )
          throw Error("数量・金額を確認してください。");
        return { ...source, ...v };
      }));
    const target = details.find((v) => v.auctionId === auctionId)!;
    if (lot.possibleDuplicates.length && !target.distinctConfirmed)
      throw Error(
        "同じ名前の商品があります。既存の商品と別の仕入れか確認してください。",
      );
    const ledgerQuantity = details.reduce((n, v) => n + v.quantity, 0),
      ledgerTotal = details.reduce((n, v) => n + v.itemTotal + v.shipping, 0),
      types = new Map<string, number>();
    details.forEach((v) =>
      types.set(
        classifyItem(v.name),
        (types.get(classifyItem(v.name)) || 0) + v.quantity,
      ),
    );
    if (ledgerTotal > 2147483647) throw Error("金額が上限を超えています。");
    const inventoryId = yahooPurchaseId(auctionId),
      owner = await claimImport("YAHOO_PURCHASE", auctionId, 180);
    if (!owner) throw Error("登録中です。再取得で結果を確認してください。");
    if (
      (await getImportRecord("YAHOO_PURCHASE", auctionId))?.status ===
      "EXCLUDED"
    ) {
      await releaseImport("YAHOO_PURCHASE", auctionId, owner);
      throw Error("登録対象から除外された商品です。");
    }
    const complete = () =>
      releaseImport("YAHOO_PURCHASE", auctionId, owner, {
        status: "REGISTERED",
        inventoryId,
        confirmedPurchase: purchaseAmounts(target),
        registeredAt: new Date().toISOString(),
      });
    let uploadedKey: string | undefined;
    try {
      const old = await getInventoryRaw(inventoryId);
      if (old) {
        const custom =
          typeof old.customFields === "string"
            ? JSON.parse(old.customFields)
            : old.customFields;
        if (custom?.__yahooPurchaseImport?.auctionId !== auctionId)
          throw Error("登録先が別の商品です。");
        await complete();
        return { ok: true as const, inventoryId, skipped: true };
      }
      const photo = await yahooImage(preview.imageUrl),
        ext =
          photo.mime === "image/png"
            ? ".png"
            : photo.mime === "image/webp"
              ? ".webp"
              : ".jpg",
        storageKey = "inventory/" + inventoryId + ext;
      await runWithAmplifyServerContext({
        nextServerContext: { cookies },
        operation: (context) =>
          uploadData(context, {
            path: storageKey,
            data: photo.bytes,
            options: {
              contentType: photo.mime,
              cacheControl: "public, max-age=31536000, immutable",
            },
          }).result,
      });
      uploadedKey = storageKey;
      const store = preview.storeInfo as YahooStore | null;
      await createInventory(
        {
          name: lot.name,
          quantity: target.quantity,
          unit: "点",
          purchasePrice: yahooPurchaseUnitPrice(target.itemTotal, target.shipping, target.quantity),
          transactionDate: lot.date,
          transactionType: "買受",
          purchaseQuantity: ledgerQuantity,
          usedGoodsItemType: [...types]
            .map(([type, n]) => `${type} ${n}点`)
            .join("、"),
          dailyPurchaseTotal: ledgerTotal,
          counterpartyName: store?.name || "",
          counterpartyAddress: store?.address || "",
          ...procurementLedgerDetails(lot.name),
          categoryId: preview.defaults.categoryId,
          categoryIds: [preview.defaults.categoryId],
          locationId: preview.defaults.locationId,
          adminMemo: `ヤフオク仕入れ / オークションID：${auctionId}\n商品合計（税込） ${target.itemTotal}円 / 送料配分 ${target.shipping}円${store ? "\nストア情報：" + store.url + "\n" + store.license : ""}`,
          customFields: {
            ...procurementLedgerDetails(lot.name).customFields,
            __yahooPurchaseImport: {
              auctionId,
              orderId: lot.orderId,
              date: lot.date,
              mailId: lot.mailId,
              itemTotal: target.itemTotal,
              shipping: target.shipping,
              quantity: target.quantity,
              store,
              sourceUrl: `https://auctions.yahoo.co.jp/jp/auction/${auctionId}`,
              registeredBy: r.createdBy,
            },
          },
          images: [
            {
              kind: "uploaded",
              storageKey,
              sortOrder: 0,
              type: "NORMAL",
              isPrimary: true,
              sourceSystem: null,
              sourceUrl: preview.imageUrl,
              thumbnailKey: null,
              mediumKey: null,
              originalHash: createHash("sha256")
                .update(photo.bytes)
                .digest("hex"),
              classification: null,
            },
          ],
        },
        { skipRedirect: true, id: inventoryId },
      );
      await complete();
      return { ok: true as const, inventoryId, skipped: false };
    } catch (e) {
      const old = await getInventoryRaw(inventoryId);
      if (old) {
        const custom =
          typeof old.customFields === "string"
            ? JSON.parse(old.customFields)
            : old.customFields;
        if (custom?.__yahooPurchaseImport?.auctionId === auctionId) {
          await complete();
          return { ok: true as const, inventoryId, skipped: false };
        }
      } else if (uploadedKey) await removeInventoryImage(uploadedKey);
      await releaseImport("YAHOO_PURCHASE", auctionId, owner, {
        status: "FAILED",
        error: message(e),
      });
      throw e;
    }
  } catch (e) {
    return { ok: false as const, error: message(e) };
  }
}
