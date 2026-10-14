"use server";
import { randomUUID } from "node:crypto";
import { getInventoryRole, getCurrentInventoryUserEmail } from "@/lib/amplify/requireInventoryUser";
import { getInventoryDetail, listCategories } from "@/lib/inventory/queries";
import { getListingDraftForInventory, getChannelListing } from "@/lib/listing/service";
import { getCategoryById, getBrandById } from "@/lib/listing/mercari/csv/masters";
import { shopsConditionFor, shopsBrandIdsFor } from "@/lib/listing/mercariBridge/webHttpSelection";
import { mercariBridgeReadRepository } from "@/lib/listing/mercariBridge/repository";
import { createMercariHttpsRuntime } from "@/lib/listing/mercariBridge/webHttpRuntime";
import { openMercariWebHttpCookieReadOnly } from "@/lib/listing/mercariBridge/webHttpReadOnlyClient";
import { webHttpDraftJobRepository } from "@/lib/listing/mercariBridge/webHttpDraftJobRepository";
import { webHttpPrivateDraftLinkRepository } from "@/lib/listing/mercariBridge/webHttpPrivateDraftLinkRepository";
import { prepareBelloInventoryImageForObservedUpload } from "@/lib/listing/mercariBridge/webHttpInventoryImageSourceServer";
import { readAcknowledgedImageAssetProof, readAcknowledgedDraftTargetProof } from "@/lib/listing/mercariBridge/webHttpAcknowledgedProofs";
import { recordVerifiedPrivateDraftLink } from "@/lib/listing/mercariBridge/webHttpPrivateDraftLink";
import { createStoredWebHttpDraftOnce } from "@/lib/listing/mercariBridge/webHttpStoredDraftCreate";
import { updateStoredWebHttpDraftOnce, type VerifiedDraftUpdateSession } from "@/lib/listing/mercariBridge/webHttpStoredDraftUpdate";
import { executeObservedImageUploadOnce } from "@/lib/listing/mercariBridge/webHttpObservedImageUpload";
import { reserveWebHttpSendStart, webHttpStageRequestId } from "@/lib/listing/mercariBridge/webHttpSendReservation";
import { initialWebHttpExecutionState } from "@/lib/listing/mercariBridge/webHttpExecutionGate";
import type { ObservedDraftSelectedProof } from "@/lib/listing/mercariBridge/webHttpObservedDraftInputMapper";
import { prepareMercariWebHttpDraftJobAction } from "./mercariWebHttpDraftJob";

export type DraftStepResult = { status: "CONTINUE" | "WAIT_INTERVAL" | "DRAFT_READY" |
  "AUTH_REQUIRED" | "SOURCE_CHANGED" | "UNSUPPORTED_SELECTION" | "RESULT_UNKNOWN_NO_RESEND" |
  "NOT_CONFIGURED" | "UNAVAILABLE"; nextEligibleAtMs: number | null };
const result = (status: DraftStepResult["status"], nextEligibleAtMs: number | null = null): DraftStepResult =>
  ({ status, nextEligibleAtMs });
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) :
  value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) =>
    a.localeCompare(b)).map(([k, v]) => [k, stable(v)])) : value;

/** One durable stage per server action. The UI may continue after the returned
 * send window; restarting always inspects receipts before any new mutation.
 */
export async function executeMercariHttpDraftStepAction(requestId: string): Promise<DraftStepResult> {
  if (!/^[a-f0-9]{64}$/.test(requestId) || await getInventoryRole() !== "ADMIN") return result("UNAVAILABLE");
  try {
    const requestedBy = await getCurrentInventoryUserEmail();
    const job = await webHttpDraftJobRepository.getJob(requestId);
    if (!job || job.requestedBy !== requestedBy || !initialWebHttpExecutionState(job)) return result("SOURCE_CHANGED");
    const runtime = createMercariHttpsRuntime();
    if (!runtime) return result("NOT_CONFIGURED");
    const session = await runtime.readSession();
    if (!session) return result("AUTH_REQUIRED");
    const { pack } = JSON.parse(job.snapshotJson);
    const condition = shopsConditionFor(pack.condition);
    const brandIds = shopsBrandIdsFor(pack);
    if (pack.imageRefs.length < 1 || pack.imageRefs.length > 20 || !condition || !brandIds ||
        (brandIds.length > 0 && getBrandById(brandIds[0])?.name !== pack.brandName))
      return result("UNSUPPORTED_SELECTION");
    const sourceUnchanged = async () => {
      const current = await prepareMercariWebHttpDraftJobAction(job.inventoryId, {
        priceYen: pack.priceYen, quantity: pack.quantity, categoryId: pack.categoryId, brandId: pack.brandId });
      return current.ok && JSON.stringify(stable(current.pack)) === JSON.stringify(stable(pack));
    };
    if (!await sourceUnchanged()) return result("SOURCE_CHANGED");
    const opened = await openMercariWebHttpCookieReadOnly(session);
    if (!opened.client || !(await opened.client.verifyTargetShop()).shopMatched) return result("AUTH_REQUIRED");
    const client = opened.client;
    const reverifyAuth = async () => {
      const check = await openMercariWebHttpCookieReadOnly(session);
      return check.client && (await check.client.verifyTargetShop()).shopMatched ?
        { status: "VALID" as const, verifiedAtMs: Date.now() } :
        { status: "AUTH_REQUIRED" as const, verifiedAtMs: null };
    };
    const duplicatePreflight: VerifiedDraftUpdateSession["duplicatePreflight"] = async (_job, target) => {
      const list = await client.listDraftCandidates(job.shopId);
      if (list.status === "AUTH_REQUIRED") return "AUTH_REQUIRED";
      if (list.status !== "OK" || !list.complete) return "UNKNOWN";
      const matches = list.candidates.filter(item => item.skuCode === job.managementCode);
      if (target) return matches.length === 1 && matches[0].id === target ?
        { status: "TARGET_ONLY_COMPLETE", draftId: target } : "FOUND";
      return matches.length === 0 ? "ABSENT_COMPLETE" : "FOUND";
    };
    const repo = runtime.repository;
    const stageResult = async (status: DraftStepResult["status"]) => {
      const slot = await repo.getSlot(job.shopId);
      return result(status, slot ? Date.parse(slot.nextEligibleAt) : null);
    };
    const assets: string[] = [], originalHashes: string[] = [], preparedHashes: string[] = [];
    for (let index = 0; index < pack.imageRefs.length; index++) {
      const image = await prepareBelloInventoryImageForObservedUpload(job, index);
      if (!image) return result("SOURCE_CHANGED");
      const ack = await readAcknowledgedImageAssetProof(job, image.prepared.preparedJpegSha256, repo);
      if (ack) {
        assets.push(ack.remoteAssetId); originalHashes.push(image.sourceProof.originalSha256);
        preparedHashes.push(image.prepared.preparedJpegSha256); continue;
      }
      const imageStage = { kind: "IMAGE_UPLOAD", preparedJpegSha256: image.prepared.preparedJpegSha256 } as const;
      if (await repo.getAttempt(webHttpStageRequestId(job, imageStage)!)) return result("RESULT_UNKNOWN_NO_RESEND");
      if (await duplicatePreflight(job, null) !== "ABSENT_COMPLETE") return result("SOURCE_CHANGED");
      const reservation = await reserveWebHttpSendStart(job, { auth: "VALID", userReauthenticatedByHuman: true,
        writeContractVerified: true, remoteDuplicate: "ABSENT", existingBinding: false }, randomUUID(), repo, Date.now, imageStage);
      if (!reservation.ok) return result(reservation.code === "WAIT_INTERVAL" ? "WAIT_INTERVAL" :
        "RESULT_UNKNOWN_NO_RESEND", reservation.nextEligibleAtMs ?? null);
      const written = await executeObservedImageUploadOnce(job, reservation, image.prepared, image.sourceProof, {
        cookieHeader: session.cookieHeader, cookieExpiresAtMs: session.expiresAtMs, fetchPort: fetch, repository: repo,
        verifyCurrentJob: sourceUnchanged, verifyAuthFresh: async () => ({ ...await reverifyAuth(), shopId: job.shopId }),
      });
      return stageResult(written.status === "ASSET_ACKNOWLEDGED" ? "CONTINUE" : "RESULT_UNKNOWN_NO_RESEND");
    }
    if (new Set(assets).size !== assets.length) return result("UNSUPPORTED_SELECTION");
    const imageProof = { status: "VERIFIED_SAME_IMAGE_BYTES" as const, shopId: job.shopId,
      inventoryId: job.inventoryId, snapshotFingerprint: job.snapshotFingerprint,
      remoteAssetId: assets[0], remoteAssetIds: assets, imageRefCount: assets.length };
    const selected: ObservedDraftSelectedProof = { status: "HUMAN_VERIFIED_SHOPS_SELECTION",
      shopId: job.shopId, snapshotFingerprint: job.snapshotFingerprint, categoryId: pack.categoryId,
      categoryPath: pack.categoryPath, belloConditionCode: pack.condition, shopsConditionEnum: condition,
      adminPriceYen: pack.priceYen, adminQuantity: pack.quantity, countryRestrictionTemplateId: "",
      channelListingScope: "CHANNEL_LISTING_SCOPE_ALL_CHANNELS", variantDefaultsVerified: true };
    const source = {
      readInventory: async (id: string) => {
        const inventory = await getInventoryDetail(id);
        if (!inventory) return null;
        const category = (await listCategories(inventory.categoryId)).find(item => item.id === inventory.categoryId);
        return { ...inventory, categoryName: category?.name ?? null };
      },
      readSavedDraft: getListingDraftForInventory,
      readSelectedCategory: async (id: string) => getCategoryById(id) ?? null,
      readSelectedBrand: async (id: string) => getBrandById(id) ?? null,
      hasExistingBinding: async () => Boolean(await runtime.readBinding(job.inventoryId) ||
        await mercariBridgeReadRepository.getBinding(job.inventoryId)),
      hasExistingChannelListing: async () => Boolean(await getChannelListing(job.inventoryId, "MERCARI_SHOPS")),
      readCurrentImageSha256: async (ref: { storageKey: string }) => {
        const index = pack.imageRefs.findIndex((image: { storageKey: string }) => image.storageKey === ref.storageKey);
        return (await prepareBelloInventoryImageForObservedUpload(job, index))?.sourceProof.originalSha256 ?? null;
      },
    };
    const common = { jobRepository: webHttpDraftJobRepository, source, sendRepository: repo,
      readVerifiedImage: async () => ({ ...imageProof, sourceImageSha256: originalHashes[0], sourceImageSha256s: originalHashes }),
      readVerifiedSelection: async () => selected,
      openVerifiedSession: async (): Promise<VerifiedDraftUpdateSession | null> => {
        const auth = await reverifyAuth();
        return auth.status === "VALID" ? { status: "VERIFIED_RECENT_HUMAN_AUTH", requestId: job.requestId,
          shopId: job.shopId, snapshotFingerprint: job.snapshotFingerprint, verifiedAtMs: auth.verifiedAtMs!,
          cookieHeader: session.cookieHeader, cookieExpiresAtMs: session.expiresAtMs,
          fetchPort: fetch, duplicatePreflight, reverifyAuth, readback: client.reconciliationReadback } : null;
      },
    };
    const target = await readAcknowledgedDraftTargetProof(job, repo, client.readVerifiedCreatedDraft);
    if (!target) {
      if (await repo.getAttempt(webHttpStageRequestId(job, { kind: "DRAFT_CREATE" })!)) return result("RESULT_UNKNOWN_NO_RESEND");
      const created = await createStoredWebHttpDraftOnce(requestId, requestedBy!, { ...common,
        readVerifiedSeed: async () => ({ status: "VERIFIED_OBSERVED_SEED_STRATEGY", snapshotFingerprint: job.snapshotFingerprint, value: Math.random() }),
        readVerifiedContract: async () => ({ status: "VERIFIED_OBSERVED_CREATE_CONTRACT", requestId, snapshotFingerprint: job.snapshotFingerprint }),
      });
      return stageResult(created.detail === "WAIT_INTERVAL" ? "WAIT_INTERVAL" :
        created.writeResult?.status === "CREATE_ACKNOWLEDGED_NEEDS_UPDATE" ? "CONTINUE" : "RESULT_UNKNOWN_NO_RESEND");
    }
    const update = await repo.getAttempt(webHttpStageRequestId(job, { kind: "DRAFT_UPDATE", draftId: target.draftId })!);
    if (!update) {
      const updated = await updateStoredWebHttpDraftOnce(requestId, requestedBy!, { ...common,
        readVerifiedTarget: async () => ({ ...target, requestId }),
        readVerifiedContract: async () => ({ status: "VERIFIED_OBSERVED_UPDATE_CONTRACT", requestId,
          snapshotFingerprint: job.snapshotFingerprint, targetDraftId: target.draftId }),
      });
      if (updated.writeResult?.status !== "UPDATE_ACKNOWLEDGED_NEEDS_READBACK")
        return stageResult(updated.detail === "WAIT_INTERVAL" ? "WAIT_INTERVAL" : "RESULT_UNKNOWN_NO_RESEND");
    }
    const recorded = await recordVerifiedPrivateDraftLink(job, target.draftId, preparedHashes,
      repo, client.readVerifiedUpdatedDraft, webHttpPrivateDraftLinkRepository);
    return result(recorded.status === "RECORDED" || recorded.status === "ALREADY_RECORDED" ? "DRAFT_READY" : "RESULT_UNKNOWN_NO_RESEND");
  } catch { return result("UNAVAILABLE"); }
}
