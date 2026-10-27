"use server";
import {econveniListingAction} from './econveniListing';
import {manualWriteRestriction} from '@/lib/listing/econveni/manualWriteGuard';
import {manualLinkedStop} from '@/lib/listing/econveni/manualStop';
import {markInventoryPublished} from '@/lib/listing/publicationCategory';
import { commonYahooUpdateAction,commonOperationSourceHash } from "./ecCommonOperations";
import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import {
  canEditInventory,
  getInventoryRole,
  getCurrentInventoryUserEmail,
  getCurrentInventoryUserSub,
} from "@/lib/amplify/requireInventoryUser";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { getInventoryDetail } from "@/lib/inventory/queries";
import { getChannelListing, getListingDraftForInventory, saveListingDraft } from "@/lib/listing/service";
import { EC_CHANNELS, type EcChannel, type EcOperation, type EcReview } from "@/lib/listing/ecManagement";
import { updateMercariHttpContentAction } from "./mercariWebHttpLifecycle";
import { reviewBaseContentUpdate, executeBaseContentUpdate } from "@/lib/listing/base/updateLifecycle";
import { reviewBaseListing, executeBaseListing } from "@/lib/listing/base/manualLifecycle";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
async function archivedDraft(id: string) {
  const r = await serverDataClient.models.ListingDraft.listListingDraftByInventoryId(
    { inventoryId: id },
    { ...inventoryAuthMode },
  );
  if (r.errors) throw Error("DRAFT_READ_FAILED");
  return [...r.data].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

async function publicationWithCommonUpdate(base:EcReview, update:Partial<EcReview>):Promise<EcReview|null> {
  if(update.status==='DONE')return null;
  if(update.status!=='READY'||!update.token)return {...base,...update};
  const token='SYNC.'+Buffer.from(JSON.stringify({s:await commonOperationSourceHash(base.inventoryId),u:update.token})).toString('base64url');
  return {...base,...update,operation:'PUBLISH',token,message:'保存した共通の商品情報を反映してから出品します。'};
}

/** A bounded, one-product step. The client queues products; no unbounded server job or automatic retry of uncertain writes. */
export async function reviewEcListingAction(
  id: string,
  channel: EcChannel,
  operation: EcOperation,
): Promise<EcReview> {
  const base: EcReview = {
    inventoryId: id,
    channel,
    operation,
    title: "",
    status: "BLOCKED",
    message: "操作を確認できませんでした。",
  };
  if (
    !validId(id) ||
    !EC_CHANNELS.includes(channel) ||
    !["PUBLISH", "STOP", "UPDATE", "ARCHIVE", "RESTORE"].includes(operation) ||
    !canEditInventory(await getInventoryRole())
  )
    return base;
  try {
    const item = await getInventoryDetail(id);
    if (!item) return { ...base, message: "対象商品が見つかりません。" };
    base.title = item.name;
    if(operation==='STOP'){
      const result=await manualLinkedStop(id,channel,(await getCurrentInventoryUserSub())??'');
      if(result)return result;
    }
    if(['PUBLISH','STOP','UPDATE'].includes(operation)){
      const existing=channel==='BASE'||operation==='UPDATE'?await getChannelListing(id,channel==='BASE'?'BASE':'MERCARI_SHOPS'):null;
      const warning=await manualWriteRestriction(id,channel,channel==='BASE'||operation==='UPDATE'&&channel==='MERCARI_SHOPS'?existing?.externalListingId??null:undefined);
      if(warning)return {...base,message:warning};
    }
    if ((channel === 'YAHOO' || channel === 'MERCARI_SHOPS') && (operation === 'PUBLISH' || operation === 'STOP'))
      return econveniListingAction(id,channel,operation);
    if (operation === "ARCHIVE" || operation === "RESTORE") {
      const draft = await archivedDraft(id);
      if ((operation === "ARCHIVE" && draft?.deletedAt) || (operation === "RESTORE" && !draft?.deletedAt))
        return {
          ...base,
          status: "DONE",
          message: operation === "ARCHIVE" ? "削除済みです。" : "復元済みです。",
        };
      return {
        ...base,
        status: "READY",
        token: digest([id, operation, draft?.id, draft?.updatedAt, item.updatedAt]),
        message:
          operation === "ARCHIVE"
            ? "EC一覧から削除します。在庫と販売先の商品は残ります。"
            : "EC一覧に戻します。",
        details:
          operation === "ARCHIVE"
            ? [
                "出品中の商品を止める場合は、先に販売先を選び「出品停止」を実行してください。",
                "削除後は「削除済み」から復元できます。",
              ]
            : [],
      };
    }
    const common = await getListingDraftForInventory(id);
    if (operation === "PUBLISH" && !common)
      return { ...base, message: "共通の商品情報を保存してから出品してください。" };
    if (operation === "UPDATE") return channel === "BASE" ? {...base,...await reviewBaseContentUpdate(id)} : channel === "MERCARI_SHOPS" ? {...base,...await updateMercariHttpContentAction(id,null)} : {...base,...await commonYahooUpdateAction(id,null)};
    if (channel === "BASE") {
      if(operation==='PUBLISH'){
        const existing=await getChannelListing(id,'BASE');
        if(existing?.externalListingId&&existing.status!=='ACTIVE'){
          const sync=await publicationWithCommonUpdate(base,await reviewBaseContentUpdate(id));
          if(sync)return sync;
        }
      }
      const result={...base,...await reviewBaseListing(id,operation)};
      if(operation==='PUBLISH'&&result.status==='DONE')await markInventoryPublished(id,(await getCurrentInventoryUserEmail())??'BASE出品');
      return result;
    }
    return base;
  } catch {
    return { ...base, message: "情報を取得できませんでした。接続を確認してやり直してください。" };
  }
}

export async function executeEcListingAction(
  review: EcReview,
  confirmed: boolean,
  termsAccepted = false,
): Promise<EcReview> {
  const failed: EcReview = {
    ...review,
    token: undefined,
    status: "BLOCKED",
    message: "操作を完了できませんでした。結果を確認してください。",
  };
  if (
    !confirmed ||
    !review.token ||
    review.token.length > 300 ||
    !validId(review.inventoryId) ||
    !EC_CHANNELS.includes(review.channel) ||
    !["PUBLISH", "STOP", "UPDATE", "ARCHIVE", "RESTORE"].includes(review.operation) ||
    !canEditInventory(await getInventoryRole())
  )
    return failed;
  const id = review.inventoryId;
  try {
    if(review.operation==='STOP'){
      const result=await manualLinkedStop(id,review.channel,(await getCurrentInventoryUserSub())??'',review.token);
      if(result){if(result.status==='DONE')revalidatePath('/inventory/listings');return result;}
    }
    if(['PUBLISH','STOP','UPDATE'].includes(review.operation)){
      const existing=review.channel==='BASE'||review.operation==='UPDATE'?await getChannelListing(id,review.channel==='BASE'?'BASE':'MERCARI_SHOPS'):null;
      const warning=await manualWriteRestriction(id,review.channel,review.channel==='BASE'||review.operation==='UPDATE'&&review.channel==='MERCARI_SHOPS'?existing?.externalListingId??null:undefined);
      if(warning)return {...failed,message:warning};
    }
    if ((review.channel === 'YAHOO' || review.channel === 'MERCARI_SHOPS') && (review.operation === 'PUBLISH' || review.operation === 'STOP'))
      return econveniListingAction(id,review.channel,review.operation,review.token,termsAccepted);
    if(review.operation==='PUBLISH'&&review.token.startsWith('SYNC.')) {
      let approved:{s:string;u:string};
      try{approved=JSON.parse(Buffer.from(review.token.slice(5),'base64url').toString('utf8'));}catch{return failed;}
      if(!approved||approved.s!==await commonOperationSourceHash(id)||typeof approved.u!=='string')return {...failed,message:'共通の商品情報が変わりました。出品前に確認し直してください。'};
      if(review.channel==='YAHOO')return failed;
      const updated=review.channel==='BASE'?await executeBaseContentUpdate(id,approved.u):await updateMercariHttpContentAction(id,approved.u);
      if(updated.status!=='DONE')return {...review,...updated,token:review.token,operation:'PUBLISH'};
      if(approved.s!==await commonOperationSourceHash(id))return {...failed,message:'共通の商品情報が変わりました。出品前に確認し直してください。'};
      const fresh=await reviewEcListingAction(id,review.channel,'PUBLISH');
      if(fresh.status==='DONE')return fresh;
      if(fresh.status!=='READY'||!fresh.token)return {...review,...fresh,token:review.token};
      if(fresh.token.startsWith('SYNC.'))return {...failed,message:'販売先の商品情報が変わりました。確認し直してください。'};
      const result=await executeEcListingAction(fresh,true,termsAccepted);
      return {...result,token:result.status==='WAIT'?review.token:result.token};
    }
    if (review.operation === "ARCHIVE" || review.operation === "RESTORE") {
      const check = await reviewEcListingAction(id, review.channel, review.operation);
      if (check.status === "DONE") return check;
      if (check.status !== "READY" || check.token !== review.token)
        return { ...failed, message: "商品情報が変わりました。削除・復元の確認をやり直してください。" };
      const who = await getCurrentInventoryUserEmail();
      let draft = await archivedDraft(id);
      if (!draft) {
        const item = await getInventoryDetail(id);
        if (!item) return failed;
        const saved = await saveListingDraft(
          id,
          { title: item.name, description: "", price: 0, condition: "NO_NOTABLE_DAMAGE" },
          who,
        );
        const read = await serverDataClient.models.ListingDraft.get({ id: saved.id }, inventoryAuthMode);
        if (read.errors || !read.data) return failed;
        draft = read.data;
      }
      const r = (await serverDataClient.graphql({
        query: `mutation ArchiveEcDraft($input:UpdateListingDraftInput!, $condition:ModelListingDraftConditionInput) { updateListingDraft(input:$input,condition:$condition) { id deletedAt } }`,
        variables: {
          input: {
            id: draft.id,
            deletedAt: review.operation === "ARCHIVE" ? new Date().toISOString() : null,
            updatedBy: who,
          },
          condition: { updatedAt: { eq: draft.updatedAt } },
        },
        authMode: "userPool",
      })) as { errors?: unknown; data?: { updateListingDraft?: { id: string } } };
      if (r.errors || !r.data?.updateListingDraft)
        return { ...failed, message: "保存内容が変わりました。再確認してください。" };
    } else if (review.operation === "UPDATE") {
      if(review.channel==="YAHOO")return {...review,...await commonYahooUpdateAction(id,review.token,termsAccepted)};
      const result=review.channel==="BASE"?await executeBaseContentUpdate(id,review.token):await updateMercariHttpContentAction(id,review.token);
      if(result.status==="DONE"){revalidatePath("/inventory/listings");revalidatePath(`/inventory/${id}/listing`);}
      return {...review,...result};
    } else if (review.channel === "BASE") {
      const result = await executeBaseListing(id, review.operation, review.token);
      if (!result.ok) return { ...failed, message: result.message };
      if(review.operation==='PUBLISH')await markInventoryPublished(id,(await getCurrentInventoryUserEmail())??'BASE出品');
    } else { return failed; }
    revalidatePath("/inventory/listings");
    revalidatePath(`/inventory/${id}/listing`);
    return {
      ...review,
      status: "DONE",
      token: undefined,
      message:
        review.operation === "ARCHIVE"
          ? "EC一覧から削除しました。"
          : review.operation === "RESTORE"
            ? "EC一覧に復元しました。"
            : review.operation === "STOP"
              ? "出品停止を確認しました。"
              : "出品を確認しました。",
    };
  } catch {
    return failed;
  }
}
