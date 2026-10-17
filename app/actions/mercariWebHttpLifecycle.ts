"use server";
import { getInventoryRole, getCurrentInventoryUserEmail } from "@/lib/amplify/requireInventoryUser";
import { createMercariHttpsRuntime } from "@/lib/listing/mercariBridge/webHttpRuntime";
import { openMercariWebHttpCookieReadOnly } from "@/lib/listing/mercariBridge/webHttpReadOnlyClient";
import { stopObservedWebHttpProductOnce } from "@/lib/listing/mercariBridge/webHttpProductStop";
import { reopenObservedWebHttpProduct } from "@/lib/listing/mercariBridge/webHttpProductReopen";
import { reconcilePendingProductVisibility } from "@/lib/listing/mercariBridge/webHttpProductReconcile";
import { getInventoryDetail, listCategories } from "@/lib/inventory/queries";
import { isEcListingEligible } from "@/lib/listing/ecEligibility";
import { publishPreparedWebHttpProduct, type PublishResult } from "@/lib/listing/mercariBridge/webHttpProductPublish";
import { webHttpDraftJobRepository } from "@/lib/listing/mercariBridge/webHttpDraftJobRepository";
import { webHttpPrivateDraftLinkRepository } from "@/lib/listing/mercariBridge/webHttpPrivateDraftLinkRepository";
import { prepareBelloInventoryImageForObservedUpload } from "@/lib/listing/mercariBridge/webHttpInventoryImageSourceServer";
import { readAcknowledgedImageAssetProof } from "@/lib/listing/mercariBridge/webHttpAcknowledgedProofs";
import { prepareMercariWebHttpDraftJobAction } from "./mercariWebHttpDraftJob";
import { webHttpDraftRequestId, type WebHttpDraftJob } from "@/lib/listing/mercariBridge/webHttpDraftJob";
import { createHash } from "node:crypto";
import { getListingDraftForInventory } from "@/lib/listing/service";
import { updateObservedWebHttpContent } from "@/lib/listing/mercariBridge/webHttpContentUpdate";
import { ecImageJpeg } from "@/lib/listing/ecImage";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export async function renewMercariHttpConnectionAction(): Promise<"CONNECTED" | "AUTH_REQUIRED" | "UNAVAILABLE"> {
  if (await getInventoryRole() !== "ADMIN") return "UNAVAILABLE";
  try {
    const runtime = createMercariHttpsRuntime();
    if (!runtime) return "UNAVAILABLE";
    return await runtime.refreshSession() ? "CONNECTED" : "AUTH_REQUIRED";
  } catch { return "UNAVAILABLE"; }
}
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) :
  value && typeof value === "object" ? Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)])) : value;
async function sourceUnchanged(job: WebHttpDraftJob) {
  const pack = JSON.parse(job.snapshotJson).pack;
  const current = await prepareMercariWebHttpDraftJobAction(job.inventoryId, {
    priceYen: pack.priceYen, quantity: pack.quantity, categoryId: pack.categoryId, brandId: pack.brandId,
    shippingMethod: pack.shipping.method, descriptionSuffix: pack.descriptionSuffix });
  return current.ok && JSON.stringify(stable(current.pack)) === JSON.stringify(stable(pack));
}

export async function updateMercariHttpContentAction(inventoryId:string,digest:string|null) {
  const blocked=(message:string)=>({status:"BLOCKED" as const,message});
  if(!UUID.test(inventoryId)||await getInventoryRole()!=="ADMIN"||digest!==null&&!/^[a-f0-9]{64}$/.test(digest))return blocked("この操作を行う権限がありません。");
  try {
    const principal=await getCurrentInventoryUserEmail(),runtime=createMercariHttpsRuntime();
    if(!principal||!runtime)return blocked("メルカリShopsの接続設定を確認してください。");
    const session=await runtime.readSession();
    if(!session)return blocked("メルカリShopsの接続を確認してください。");
    return await updateObservedWebHttpContent(inventoryId,principal,digest,{
      session,repository:runtime.repository,readBinding:runtime.readBinding,saveVerifiedState:runtime.saveVerifiedState,imageJpeg:ecImageJpeg,
      readSource:async id=>{
        const [draft,item]=await Promise.all([getListingDraftForInventory(id),getInventoryDetail(id)]);
        if(!draft||!item||item.saleEndDate)throw Error("SOURCE");
        const category=(await listCategories(item.categoryId)).find(c=>c.id===item.categoryId);
        if(!category||!isEcListingEligible(category.name))throw Error("CATEGORY");
        const source={title:draft.title,description:draft.description??"",price:draft.price??0,quantity:item.quantity,images:draft.images};
        return {...source,fingerprint:createHash("sha256").update(JSON.stringify([draft.id,draft.updatedAt,item.updatedAt,source])).digest("hex")};
      },
    });
  }catch{return blocked("商品情報を確認できませんでした。再読み込みしてください。");}
}

export type HttpListingState = { status: "FORBIDDEN" | "NOT_CONFIGURED" | "AUTH_REQUIRED" |
  "UNAVAILABLE" | "VERIFY_REQUIRED" | "NOT_PREPARED" | "PREPARED" | "DRAFT_READY" | "LISTED" | "STOPPED";
  productId: string | null; authenticatedUntil: string | null };
export async function getMercariHttpListingStateAction(inventoryId: string): Promise<HttpListingState> {
  const result = (status: HttpListingState["status"], productId: string | null = null,
    authenticatedUntil: string | null = null): HttpListingState => ({ status, productId, authenticatedUntil });
  if (!UUID.test(inventoryId) || await getInventoryRole() !== "ADMIN") return result("FORBIDDEN");
  try {
    const runtime = createMercariHttpsRuntime();
    if (!runtime) return result("NOT_CONFIGURED");
    const session = await runtime.readSession();
    if (!session) return result("AUTH_REQUIRED");
    const opened = await openMercariWebHttpCookieReadOnly(session);
    if (!opened.client || !(await opened.client.verifyTargetShop()).shopMatched) return result("AUTH_REQUIRED");
    const until = new Date(session.expiresAtMs).toISOString();
    const binding = await runtime.readBinding(inventoryId);
    if (binding) {
      const principal = await getCurrentInventoryUserEmail();
      if (!principal) return result("FORBIDDEN");
      const read = await opened.client.readProduct(binding.remoteProductId);
      if (!read.product || read.product.variants[0]?.skuCode !== binding.managementCode)
        return result("UNAVAILABLE", binding.remoteProductId, until);
      if (await reconcilePendingProductVisibility(binding, read.product, principal, runtime.repository) === "PENDING")
        return result("VERIFY_REQUIRED", binding.remoteProductId, until);
      await runtime.saveVerifiedState(binding, read.product.status);
      return result(read.product.status === "STATUS_OPENED" ? "LISTED" : "STOPPED", binding.remoteProductId, until);
    }
    const job = await webHttpDraftJobRepository.getJob(webHttpDraftRequestId(inventoryId));
    const link = await webHttpPrivateDraftLinkRepository.get(inventoryId);
    return result(job ? link && link.requestId === job.requestId &&
      link.snapshotFingerprint === job.snapshotFingerprint ? "DRAFT_READY" : "PREPARED" : "NOT_PREPARED", null, until);
  } catch { return result("UNAVAILABLE"); }
}

export async function publishMercariHttpListingAction(inventoryId: string, digest: string | null): Promise<PublishResult> {
  const failed = (status: PublishResult["status"]): PublishResult =>
    ({ status, preview: null, productId: null, nextEligibleAtMs: null });
  if (!UUID.test(inventoryId) || await getInventoryRole() !== "ADMIN" ||
      digest !== null && !/^[a-f0-9]{64}$/.test(digest)) return failed("SOURCE_CHANGED");
  try {
    const principal = await getCurrentInventoryUserEmail();
    const runtime = createMercariHttpsRuntime();
    if (!principal || !runtime) return failed("STORAGE_UNAVAILABLE");
    const session = await runtime.readSession();
    if (!session) return failed("AUTH_REQUIRED");
    return await publishPreparedWebHttpProduct(webHttpDraftRequestId(inventoryId), principal, digest, {
      session, repository: runtime.repository, readBinding: runtime.readBinding,
      saveBinding: runtime.saveBinding, getJob: webHttpDraftJobRepository.getJob, sourceUnchanged,
      readDraftId: async job => {
        const link = await webHttpPrivateDraftLinkRepository.get(job.inventoryId);
        return link && link.shopId === job.shopId && link.requestId === job.requestId &&
          link.snapshotFingerprint === job.snapshotFingerprint && link.status === "PRIVATE_DRAFT_VERIFIED" ? link.remoteDraftId : null;
      },
      readVerifiedDraft: async job => {
        const link = await webHttpPrivateDraftLinkRepository.get(job.inventoryId);
        if (!link || link.shopId !== job.shopId || link.requestId !== job.requestId ||
            link.snapshotFingerprint !== job.snapshotFingerprint || link.status !== "PRIVATE_DRAFT_VERIFIED") return null;
        const refs = JSON.parse(job.snapshotJson).pack.imageRefs;
        const assetIds: string[] = [];
        for (let index = 0; index < refs.length; index++) {
          const image = await prepareBelloInventoryImageForObservedUpload(job, index);
          if (!image) return null;
          const ack = await readAcknowledgedImageAssetProof(job, image.prepared.preparedJpegSha256, runtime.repository);
          if (!ack) return null;
          assetIds.push(ack.remoteAssetId);
        }
        return assetIds.length && new Set(assetIds).size === assetIds.length ? { id: link.remoteDraftId, assetIds } : null;
      },
    });
  } catch { return failed("STORAGE_UNAVAILABLE"); }
}

export async function stopMercariHttpListingAction(inventoryId: string) {
  if (!UUID.test(inventoryId) || await getInventoryRole() !== "ADMIN")
    return { status: "FORBIDDEN", stopConfirmed: false, nextEligibleAtMs: null };
  try {
    const principal = await getCurrentInventoryUserEmail();
    const runtime = createMercariHttpsRuntime();
    if (!principal || !runtime) return { status: "NOT_CONFIGURED", stopConfirmed: false, nextEligibleAtMs: null };
    const session = await runtime.readSession();
    if (!session) return { status: "AUTH_REQUIRED", stopConfirmed: false, nextEligibleAtMs: null };
    const result = await stopObservedWebHttpProductOnce(inventoryId, principal, {
      session, repository: runtime.repository, readBinding: runtime.readBinding,
    });
    if (result.stopConfirmed) {
      const binding = await runtime.readBinding(inventoryId);
      if (!binding || binding.remoteProductId !== result.productId) throw Error("LINK_CHANGED");
      await runtime.saveVerifiedState(binding, "STATUS_UNOPENED");
    }
    return { status: result.status, stopConfirmed: result.stopConfirmed, nextEligibleAtMs: result.nextEligibleAtMs };
  } catch { return { status: "STORAGE_UNAVAILABLE", stopConfirmed: false, nextEligibleAtMs: null }; }
}

export async function reopenMercariHttpListingAction(inventoryId: string, digest: string | null): Promise<PublishResult> {
  const failed = (status: PublishResult["status"]): PublishResult => ({ status, preview: null, productId: null, nextEligibleAtMs: null });
  if (!UUID.test(inventoryId) || await getInventoryRole() !== "ADMIN" ||
      digest !== null && !/^[a-f0-9]{64}$/.test(digest)) return failed("SOURCE_CHANGED");
  try {
    const principal = await getCurrentInventoryUserEmail(), runtime = createMercariHttpsRuntime();
    if (!principal || !runtime) return failed("STORAGE_UNAVAILABLE");
    const session = await runtime.readSession();
    if (!session) return failed("AUTH_REQUIRED");
    const result = await reopenObservedWebHttpProduct(inventoryId, principal, digest, {
      session, repository: runtime.repository, readBinding: runtime.readBinding,
      canReopen: async (id, quantity) => {
        const inventory = await getInventoryDetail(id);
        if (!inventory || inventory.id !== id || inventory.saleEndDate !== null || inventory.quantity < quantity) return false;
        const category = (await listCategories(inventory.categoryId)).find(item => item.id === inventory.categoryId);
        return !!category && isEcListingEligible(category.name) && category.name !== "売り切れ";
      },
    });
    if (result.status === "PUBLISHED") {
      const binding = await runtime.readBinding(inventoryId);
      if (!binding || binding.remoteProductId !== result.productId) return failed("STORAGE_UNAVAILABLE");
      await runtime.saveVerifiedState(binding, "STATUS_OPENED");
    }
    return result;
  } catch { return failed("STORAGE_UNAVAILABLE"); }
}
