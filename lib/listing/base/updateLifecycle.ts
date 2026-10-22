import "server-only";
import {listingQuantity} from "../quantity";
import { createHash } from "node:crypto";
import {
  getChannelListing,
  getListingDraftForInventory,
} from "@/lib/listing/service";
import { getInventoryDetail, listCategories } from "@/lib/inventory/queries";
import { isEcListingEligible } from "../ecEligibility";
import { commonCategory } from "../commonSettings";
import { getBaseConnectionState } from "@/lib/base/connectionState";
import { baseImageUrl } from "../ecImage";
import {
  readBaseItem,
  claimBaseManual,
  finishBaseManual,
  type BaseManualItem,
} from "./manualLifecycle";
import {
  editManualBaseContent,
  addManualBaseImage,
  deleteManualBaseImage,
  setManualBaseCategory,
} from "./adapter";
import type { EcReview } from "../ecManagement";
type Result = Pick<
  EcReview,
  | "status"
  | "message"
  | "token"
  | "price"
  | "quantity"
  | "imageCount"
  | "details"
  | "nextAt"
> & { title?: string };
type Progress = {
  token: string;
  source: string;
  remote: string;
  visible: boolean;
  step: number;
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const blocked = (message: string): Result => ({ status: "BLOCKED", message });
async function source(id: string, claimToken?: string) {
  if (
    process.env.BASE_MANUAL_LISTING_ENABLED !== "1" ||
    !(await getBaseConnectionState()).requestWriteItems
  )
    throw Error("BASEの出品設定と接続を確認してください。");
  const [row, draft, item] = await Promise.all([
    getChannelListing(id, "BASE"),
    getListingDraftForInventory(id),
    getInventoryDetail(id),
  ]);
  if (!row?.externalListingId || !draft || !item)
    throw Error("BASEの商品と保存済みの商品情報を確認してください。");
  if (row.status === "PUBLISHING" && row.lastError !== claimToken)
    throw Error("BASEの操作中、または前回結果の確認待ちです。");
  if (row.status === "ERROR")
    throw Error(
      "前回の操作結果が未確定です。BASEの商品状態を確認してください。",
    );
  const category = (await listCategories(item.categoryId)).find(
    (c) => c.id === item.categoryId,
  )?.name;
  if (
    !isEcListingEligible(category ?? null) ||
    item.saleEndDate ||
    !Number.isSafeInteger(item.quantity) ||
    item.quantity < 0
  )
    throw Error("在庫数・販売状況を確認してください。");
  const content = {
    title: row.overrideTitle ?? draft.title,
    detail: row.overrideDescription ?? draft.description ?? "",
    price: draft.channelPrices ? draft.channelPrices.BASE ?? 0 : row.overridePrice ?? draft.price ?? 0,
    stock: listingQuantity(draft,item.quantity),
  };
  if (
    !Number.isSafeInteger(content.stock) || content.stock<1 || content.stock>item.quantity ||
    !content.title.trim() ||
    !Number.isSafeInteger(content.price) ||
    content.price < 1 ||
    draft.images.length < 1 ||
    draft.images.length > 20
  )
    throw Error("商品名・単価・画像（1〜20枚）を確認してください。");
  const mapping = (row.categoryMapping ?? {}) as Record<string, unknown>;
  const fingerprint = hash([draft.id, draft.updatedAt, content, draft.images]);
  return { row, draft, content, mapping, fingerprint };
}
const matchesContent = (
  r: BaseManualItem,
  c: { title: string; detail: string; price: number; stock: number },
) =>
  r.title === c.title &&
  r.detail === c.detail &&
  r.price === c.price &&
  r.quantity === c.stock;
function progress(value: unknown): Progress | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Progress;
  return [p.token, p.source, p.remote].every(
    (x) => typeof x === "string" && /^[a-f0-9]{64}$/.test(x),
  ) &&
    typeof p.visible === "boolean" &&
    Number.isInteger(p.step) &&
    p.step >= 0 &&
    p.step <= 41
    ? p
    : null;
}
export async function reviewBaseContentUpdate(id: string): Promise<Result> {
  try {
    const s = await source(id),
      remote = await readBaseItem(s.row.externalListingId!);
    if (remote.hasVariations)
      return blocked(
        "種類別在庫がある商品はBASEの商品画面で更新してください。",
      );
    if (
      s.mapping.baseContentSource === s.fingerprint &&
      s.mapping.baseContentRemote === hash(remote)
    )
      return { status: "DONE", message: "保存した内容はBASEに反映済みです。" };
    const p = progress(s.mapping.baseUpdate);
    if (p && (p.source !== s.fingerprint || p.remote !== hash(remote)))
      return blocked(
        "更新途中に商品情報が変わりました。BASEの内容を確認してください。",
      );
    return {
      status: "READY",
      token: p?.token ?? hash([id, s.row.id, s.fingerprint, remote]),
      title: s.content.title,
      price: s.content.price,
      quantity: s.content.stock,
      imageCount: s.draft.images.length,
      message: p
        ? "前回の続きから更新します。"
        : "保存した商品情報をBASEに反映します。",
      details: [
        "商品名・説明・単価・数量を更新します。",
        ...(s.draft.commonCategoryId ? ["共通の商品カテゴリをBASEに反映します。"] : []),
        `画像を共通タブの${s.draft.images.length}枚に揃えます。`,
        remote.visible
          ? "公開中のまま更新します。"
          : "非公開のまま更新します。",
      ],
    };
  } catch (e) {
    return blocked(
      e instanceof Error ? e.message : "商品情報を確認できませんでした。",
    );
  }
}
/** One bounded write per call, with a stored receipt before the next image. */
export async function executeBaseContentUpdate(
  id: string,
  confirmed: string,
): Promise<Result> {
  let claim: string | undefined;
  let active: Awaited<ReturnType<typeof source>> | undefined;
  try {
    const s = await source(id);
    active = s;
    const remote = await readBaseItem(s.row.externalListingId!);
    if (remote.hasVariations)
      return blocked(
        "種類別在庫がある商品はBASEの商品画面で更新してください。",
      );
    if (
      s.mapping.baseContentSource === s.fingerprint &&
      s.mapping.baseContentRemote === hash(remote)
    )
      return { status: "DONE", message: "内容を更新しました。" };
    let p = progress(s.mapping.baseUpdate);
    if (!p)
      p = {
        token: hash([id, s.row.id, s.fingerprint, remote]),
        source: s.fingerprint,
        remote: hash(remote),
        visible: remote.visible,
        step: 0,
      };
    if (
      p.token !== confirmed ||
      p.source !== s.fingerprint ||
      p.remote !== hash(remote)
    )
      return blocked("確認後に商品情報が変わりました。確認し直してください。");
    let step = p.step;
    const count = s.draft.images.length;
    const imageUrl =
      step >= 1 && step <= count
        ? await baseImageUrl(s.draft.images[step - 1])
        : null;
    claim = await claimBaseManual(s.row);
    const fresh = await source(id, claim),
      before = await readBaseItem(s.row.externalListingId!);
    if (
      fresh.fingerprint !== s.fingerprint ||
      fresh.row.externalListingId !== s.row.externalListingId ||
      hash(before) !== hash(remote)
    ) {
      await finishBaseManual(s.row, claim, { status: s.row.status });
      claim = undefined;
      return blocked("確認後に商品情報が変わりました。確認し直してください。");
    }
    let acknowledgedImage: string | null = null;
    if (step === 0) {
      await editManualBaseContent(remote.id, s.content);
      step = 1;
    } else if (step <= count) {
      acknowledgedImage = await addManualBaseImage(remote.id, step, imageUrl!);
      step++;
    } else {
      const extra = remote.imageSlots.findLastIndex(
        (url, i) => i >= count && !!url,
      );
      if (extra >= 0) {
        await deleteManualBaseImage(remote.id, extra + 1);
        step++;
      }
    }
    const readback = await readBaseItem(remote.id);
    if (readback.visible !== p.visible || !matchesContent(readback, s.content))
      throw Error("BASEの変更結果を確認できませんでした。");
    if (p.step >= 1 && p.step <= count && (!acknowledgedImage || readback.imageSlots[p.step - 1] !== acknowledgedImage))
      throw Error("画像の保存結果を確認できませんでした。");
    if (
      p.step > count &&
      readback.images.length >= remote.images.length &&
      remote.images.length > count
    )
      throw Error("画像の削除結果を確認できませんでした。");
    const done =
      step > count &&
      readback.images.length === count &&
      readback.imageSlots.slice(0, count).every(Boolean);
    const category = commonCategory(s.draft.commonCategoryId)?.base;
    if (done && category)
      await setManualBaseCategory(remote.id, category.id, s.mapping.baseCommonCategoryId);
    const mapping = {
      ...s.mapping,
      baseImageSource: hash([s.draft.id, s.draft.images]),
      baseImageCount: Math.min(count, Math.max(0, step - 1)),
      baseUpdate: done ? null : { ...p, step, remote: hash(readback) },
      ...(done
        ? {
            baseContentSource: s.fingerprint,
            baseContentRemote: hash(readback),
            ...(category ? { baseCommonCategoryId: category.id } : {}),
          }
        : {}),
    };
    await finishBaseManual(s.row, claim, {
      status: p.visible ? "ACTIVE" : "PAUSED",
      categoryMapping: JSON.stringify(mapping),
    });
    claim = undefined;
    return done
      ? {
          status: "DONE",
          message: "BASEの商品内容と画像の更新を確認しました。",
        }
      : {
          status: "WAIT",
          token: confirmed,
          message: `BASEの商品内容を更新中（画像 ${Math.min(count, step - 1)} / ${count}枚）`,
          nextAt: Date.now() + 500,
        };
  } catch (e) {
    if (claim && active)
      await finishBaseManual(active.row, claim, {
        status: "ERROR",
        lastError:
          "商品内容の更新結果が未確定です。BASEの内容を確認してください。",
      }).catch(() => {});
    return blocked(
      e instanceof Error ? e.message : "更新結果を確認できませんでした。",
    );
  }
}
