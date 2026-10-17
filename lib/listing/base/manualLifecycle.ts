import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { serverDataClient, inventoryAuthMode } from "@/lib/amplify/dataClient";
import { getAccessToken } from "@/lib/base/oauth";
import { getBaseConnectionState } from "@/lib/base/connectionState";
import { getInventoryDetail, listCategories } from "@/lib/inventory/queries";
import { isEcListingEligible } from "@/lib/listing/ecEligibility";
import { getChannelListing, getListingDraftForInventory } from "@/lib/listing/service";
import { baseImageUrl } from "../ecImage";
import { fetchWithTimeout } from "@/lib/http/fetchWithTimeout";
import { createBaseProduct, addManualBaseImage, setManualBaseVisibility } from "./adapter";
import type { EcReview } from "../ecManagement";
import type { ChannelListingRecord } from "../types";

export type BaseManualItem = {
  id: string;
  title: string;
  detail: string;
  price: number;
  quantity: number;
  visible: boolean;
  images: string[];
  imageSlots: (string|null)[];
  hasVariations: boolean;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Review = Pick<
  EcReview,
  "status" | "message" | "token" | "price" | "quantity" | "imageCount" | "nextAt" | "details"
> & { title?: string };
export async function readBaseItem(id: string): Promise<BaseManualItem> {
  if (!/^[1-9][0-9]*$/.test(id)) throw Error("ID");
  const response = await fetchWithTimeout(
    `https://api.thebase.in/1/items/detail/${id}?max_image_no=20`,
    { headers: { Authorization: `Bearer ${await getAccessToken()}` }, cache: "no-store" },
    { label: "BASE商品確認" },
  );
  if (!response.ok) throw Error("READ");
  const data = (await response.json()).item;
  if (
    !data ||
    String(data.item_id) !== id ||
    ![0, 1, "0", "1"].includes(data.visible) ||
    !Number.isFinite(Number(data.price)) ||
    !Number.isInteger(Number(data.stock))
  )
    throw Error("RESPONSE");
  return {
    id,
    title: String(data.title),
    detail: String(data.detail ?? ""),
    price: Number(data.price),
    quantity: Number(data.stock),
    visible: Number(data.visible) === 1,
    hasVariations: data.variations != null && (Array.isArray(data.variations) ? data.variations.length > 0 : true),
    images: Array.from({ length: 20 }, (_, i) => data[`img${i + 1}_origin`]).filter(
      (v): v is string => typeof v === "string" && v.startsWith("https://"),
    ),
    imageSlots: Array.from({length:20},(_,i)=> typeof data[`img${i+1}_origin`] === "string" ? data[`img${i+1}_origin`] : null),
  };
}
async function eligible(id: string, quantity: number) {
  const item = await getInventoryDetail(id);
  if (!item || item.saleEndDate || item.quantity < quantity || quantity < 1) return false;
  const name = (await listCategories(item.categoryId)).find((c) => c.id === item.categoryId)?.name;
  return !!name && name !== "売り切れ" && isEcListingEligible(name);
}
export async function claimBaseManual(row: ChannelListingRecord) {
  const token = `EC_MANUAL:${randomUUID()}`;
  const r = (await serverDataClient.graphql({
    query: `mutation ClaimBaseManual($input:UpdateChannelListingInput!, $condition:ModelChannelListingConditionInput) { updateChannelListing(input:$input,condition:$condition) { id } }`,
    variables: {
      input: { id: row.id, status: "PUBLISHING", lastError: token },
      condition: { updatedAt: { eq: row.updatedAt }, status: { ne: "PUBLISHING" } },
    },
    authMode: "userPool",
  })) as { errors?: unknown; data?: { updateChannelListing?: unknown } };
  if (r.errors || !r.data?.updateChannelListing) throw Error("BUSY");
  return token;
}
export async function finishBaseManual(row: ChannelListingRecord, token: string, patch: Record<string, unknown>) {
  const r = (await serverDataClient.graphql({
    query: `mutation FinishBaseManual($input:UpdateChannelListingInput!, $condition:ModelChannelListingConditionInput) { updateChannelListing(input:$input,condition:$condition) { id } }`,
    variables: {
      input: { id: row.id, lastError: null, ...patch },
      condition: { lastError: { eq: token }, status: { eq: "PUBLISHING" } },
    },
    authMode: "userPool",
  })) as { errors?: unknown; data?: { updateChannelListing?: unknown } };
  if (r.errors || !r.data?.updateChannelListing) throw Error("SAVE");
}

/** One bounded preparation step. Every new product starts private and retains its returned ID. */
export async function reviewBaseListing(id: string, operation: "PUBLISH" | "STOP"): Promise<Review> {
  if (process.env.BASE_MANUAL_LISTING_ENABLED !== "1")
    return { status: "BLOCKED", message: "BASEの出品操作が未設定です。出品設定を確認してください。" };
  const connection = await getBaseConnectionState();
  if (!connection.requestWriteItems)
    return {
      status: "BLOCKED",
      message: "BASEの商品登録権限が必要です。出品設定のBASE連携を確認してください。",
    };
  let row = await getChannelListing(id, "BASE");
  if (row?.status === "PUBLISHING")
    return {
      status: "BLOCKED",
      message: "別の操作中、または前回結果の確認待ちです。BASE管理画面で確認してください。",
    };
  if (!row?.externalListingId) {
    if (operation === "STOP") return { status: "DONE", message: "BASEに登録された商品はありません。" };
    if (row?.status === "ERROR")
      return {
        status: "BLOCKED",
        message: "前回の登録結果が未確定です。BASE管理画面で確認してください。重複登録は行いません。",
      };
    const draft = await getListingDraftForInventory(id),
      inventory = await getInventoryDetail(id);
    if (!draft?.images.length || !inventory || !draft.price || !(await eligible(id, inventory.quantity)))
      return { status: "BLOCKED", message: "共通の商品情報の価格・画像・在庫数を確認してください。" };
    if (!row) {
      const result = await serverDataClient.models.ChannelListing.create(
        { id: `ec-base-${id}`, listingDraftId: draft.id, inventoryId: id, channel: "BASE", status: "DRAFT" },
        inventoryAuthMode,
      );
      if (result.errors || !result.data)
        return { status: "BLOCKED", message: "別の登録操作が始まりました。状態を確認してください。" };
      row = await getChannelListing(id, "BASE");
      if (!row) throw Error("ROW");
    }
    const token = await claimBaseManual(row);
    try {
      const created = await createBaseProduct({
        draft,
        quantity: inventory.quantity,
        overrideTitle: row.overrideTitle,
        overrideDescription: row.overrideDescription,
        overridePrice: row.overridePrice,
      }, true);
      await finishBaseManual(row, token, {
        externalListingId: created.externalProductId,
        status: created.visibility === "PRIVATE" ? "PAUSED" : "ERROR",
        lastError: created.visibility === "PRIVATE" ? null : "BASEの非公開状態を確認してください。",
      });
      return {
        status: "WAIT",
        nextAt: Date.now() + 1000,
        message: "BASEに非公開で登録しました。画像を準備します。",
      };
    } catch {
      await finishBaseManual(row, token, {
        status: "ERROR",
        lastError: "登録結果が未確定です。BASEの商品一覧を確認してください。",
      }).catch(() => {});
      throw Error("CREATE_UNKNOWN");
    }
  }
  const remote = await readBaseItem(row.externalListingId);
  if (remote.visible === (operation === "PUBLISH")) {
    const status = remote.visible ? "ACTIVE" : "PAUSED";
    if (row.status !== status || row.lastError) {
      const token = await claimBaseManual(row);
      await finishBaseManual(row, token, { status });
    }
    return { status: "DONE", message: remote.visible ? "すでに出品中です。" : "すでに出品停止中です。" };
  }
  if (operation === "PUBLISH") {
    if (!(await eligible(id, remote.quantity)))
      return { status: "BLOCKED", message: "在庫数または販売状況を確認してください。" };
    const draft = await getListingDraftForInventory(id);
    if (!draft?.images.length) return { status: "BLOCKED", message: "出品画像を選択して保存してください。" };
    const source = hash([draft.id, draft.images]);
    const mapping = (row.categoryMapping ?? {}) as Record<string, unknown>;
    if (mapping.baseImageSource && mapping.baseImageSource !== source)
      return {
        status: "BLOCKED",
        message: "画像の準備後に共通情報が変わりました。BASEの商品画像と内容を確認してください。",
      };
    const count = typeof mapping.baseImageCount === "number" ? mapping.baseImageCount : 0;
    if ((!remote.images.length || mapping.baseImageSource === source) && count < draft.images.length) {
      const token = await claimBaseManual(row);
      try {
        const url = await baseImageUrl(draft.images[count]);
        if (!url) throw Error("IMAGE");
        await addManualBaseImage(remote.id, count + 1, url);
        const readback = await readBaseItem(remote.id);
        if (readback.images.length < count + 1) throw Error("IMAGE_UNKNOWN");
        await finishBaseManual(row, token, {
          status: "PAUSED",
          categoryMapping: JSON.stringify({ ...mapping, baseImageSource: source, baseImageCount: count + 1 }),
        });
        return {
          status: "WAIT",
          nextAt: Date.now() + 1000,
          message: `BASEの画像を準備中（${count + 1} / ${draft.images.length}枚）`,
        };
      } catch {
        await finishBaseManual(row, token, { status: "ERROR", lastError: "画像の保存結果を確認してください。" }).catch(
          () => {},
        );
        throw Error("IMAGE_UNKNOWN");
      }
    }
    if (!remote.images.length || remote.price <= 0)
      return { status: "BLOCKED", message: "BASE商品の画像と価格を確認してください。" };
  }
  return {
    status: "READY",
    title: remote.title,
    price: remote.price,
    quantity: remote.quantity,
    imageCount: remote.images.length,
    token: hash([id, operation, row.id, remote]),
    message:
      operation === "PUBLISH" ? "BASEで公開する内容を確認してください。" : "BASEの商品を非公開にします。",
  };
}
export async function executeBaseListing(
  id: string,
  operation: "PUBLISH" | "STOP",
  digest: string,
): Promise<{ ok: boolean; message: string }> {
  const row = await getChannelListing(id, "BASE");
  if (!row?.externalListingId || row.status === "PUBLISHING")
    return { ok: false, message: "登録内容を確認し直してください。" };
  const remote = await readBaseItem(row.externalListingId);
  if (hash([id, operation, row.id, remote]) !== digest)
    return { ok: false, message: "BASEの商品内容が変わりました。確認し直してください。" };
  if (operation === "PUBLISH" && !(await eligible(id, remote.quantity)))
    return { ok: false, message: "在庫数または販売状況が変わりました。" };
  const token = await claimBaseManual(row);
  try {
    await setManualBaseVisibility(remote.id, operation === "PUBLISH");
    const readback = await readBaseItem(remote.id);
    if (readback.visible !== (operation === "PUBLISH")) throw Error("VERIFY");
    await finishBaseManual(row, token, {
      status: readback.visible ? "ACTIVE" : "PAUSED",
      ...(readback.visible
        ? {
            lastListedAt: new Date().toISOString(),
            ...(!row.firstListedAt ? { firstListedAt: new Date().toISOString() } : {}),
          }
        : {}),
    });
    return { ok: true, message: "確認しました。" };
  } catch {
    await finishBaseManual(row, token, { status: "ERROR", lastError: "公開状態の変更結果を確認してください。" }).catch(
      () => {},
    );
    return { ok: false, message: "BASEの変更結果を確認できません。販売先で確認してください。" };
  }
}
