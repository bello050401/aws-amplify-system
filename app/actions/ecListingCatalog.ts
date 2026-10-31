"use server";
import {overlayManualStops} from '@/lib/listing/econveni/manualStop';
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import {readEconveniCatalog} from '@/lib/listing/econveni/runtimeStore';
import {readManualSync} from '@/lib/listing/econveni/manualSync';
import {overlayManualStatuses} from '@/lib/listing/econveni/manualSyncModel';
import {remoteOverview,soldListingReferences} from '@/lib/listing/econveni/overviewCatalog';
import type {EconveniWorkflow} from '@/lib/listing/econveni/workflowStore';
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import type { EcCatalog, EcChannelState, EcState } from "@/lib/listing/ecManagement";

async function collect<T>(
  read: (nextToken?: string) => Promise<{ data: T[]; nextToken?: string | null; errors?: unknown }>,
): Promise<T[]> {
  const rows: T[] = [];
  let token: string | undefined;
  do {
    const result = await read(token);
    if (result.errors) throw Error("READ_FAILED");
    rows.push(...result.data);
    token = result.nextToken ?? undefined;
    if (rows.length > 20000) throw Error("LIMIT");
  } while (token);
  return rows;
}
const legacyState = (status: string): EcState =>
  (({
    ACTIVE: "ACTIVE",
    PAUSED: "STOPPED",
    SOLD: "ENDED",
    ENDED: "ENDED",
    ARCHIVED: "ENDED",
    PUBLISHING: "PENDING",
    QUEUED: "PENDING",
    ERROR: "ERROR",
  })[status] as EcState | undefined) ?? "DRAFT";

/** Stored results only: opening the table never sends publication or status requests to marketplaces. */
export async function getEcListingCatalogAction(inventoryId?:string): Promise<EcCatalog> {
  const role = await getInventoryRole();
  if (!role) return { channels: {}, archivedIds: [], errors: ["ログインし直してください。"] };
  if(inventoryId!==undefined&&!/^[a-zA-Z0-9-]{8,80}$/.test(inventoryId))return {channels:{},archivedIds:[],errors:['対象の商品を確認してください。']};
  const results = await Promise.allSettled([
    inventoryId ? collect(token=>serverDataClient.models.ChannelListing.listChannelListingByInventoryId({inventoryId},{nextToken:token,selectionSet:["inventoryId","channel","status","externalListingId","listingUrl","updatedAt"],...inventoryAuthMode})) : collect((token) =>
      serverDataClient.models.ChannelListing.list({
        limit: 1000,
        nextToken: token,
        selectionSet: ["inventoryId", "channel", "status", "externalListingId", "listingUrl", "updatedAt"],
        ...inventoryAuthMode,
      }),
    ),
    inventoryId ? serverDataClient.models.YahooAuctionListing.get({inventoryId},{...inventoryAuthMode}).then(r=>{if(r.errors)throw Error('READ_FAILED');return r.data?[r.data]:[];}) : collect((token) =>
      serverDataClient.models.YahooAuctionListing.list({
        limit: 1000,
        nextToken: token,
        selectionSet: ["inventoryId", "auctionId", "remoteStatus", "checkedAt"],
        ...inventoryAuthMode,
      }),
    ),
    role === "ADMIN"
      ? inventoryId ? serverDataClient.models.MercariBridgeHttpProductLink.get({inventoryId},{...inventoryAuthMode}).then(r=>{if(r.errors)throw Error('READ_FAILED');return r.data?[r.data]:[];}) : collect((token) =>
          serverDataClient.models.MercariBridgeHttpProductLink.list({
            limit: 1000,
            nextToken: token,
            ...inventoryAuthMode,
          }),
        )
      : Promise.resolve(null),
    inventoryId ? collect(token=>serverDataClient.models.ListingDraft.listListingDraftByInventoryId({inventoryId},{nextToken:token,selectionSet:["inventoryId","deletedAt"],...inventoryAuthMode})) : collect((token) =>
      serverDataClient.models.ListingDraft.list({
        limit: 1000,
        nextToken: token,
        selectionSet: ["inventoryId", "deletedAt"],
        ...inventoryAuthMode,
      }),
    ),
  ]);
  const catalog: EcCatalog = { channels: {}, archivedIds: [], errors: [] };
  if (results[0].status === "fulfilled") {
    catalog.channels.BASE = {};
    catalog.channels.MERCARI_SHOPS = {};
    for (const row of results[0].value)
      if (row.channel === "BASE" || row.channel === "MERCARI_SHOPS") {
        catalog.channels[row.channel]![row.inventoryId] = {
          state: legacyState(row.status),
          externalId: row.externalListingId ?? null,
          url: row.listingUrl ?? null,
          checkedAt: row.updatedAt,
        };
      }
  } else catalog.errors.push("BASE・過去のメルカリ出品情報を取得できませんでした。");
  if (results[1].status === "fulfilled") {
    catalog.channels.YAHOO = {};
    for (const row of results[1].value)
      catalog.channels.YAHOO[row.inventoryId] = {
        state:
          row.remoteStatus === "open" ? "ACTIVE" : row.remoteStatus === "cancelled" ? "STOPPED" : "ENDED",
        externalId: row.auctionId,
        url: `https://auctions.yahoo.co.jp/jp/auction/${encodeURIComponent(row.auctionId)}`,
        checkedAt: row.checkedAt,
      };
  } else catalog.errors.push("ヤフオクの出品情報を取得できませんでした。");
  if (results[2].status === "fulfilled" && results[2].value) {
    const target: Record<string, EcChannelState> = catalog.channels.MERCARI_SHOPS ?? {};
    for (const row of results[2].value)
      target[row.inventoryId] = {
        state:
          row.remoteStatus === "STATUS_OPENED"
            ? "ACTIVE"
            : row.remoteStatus === "STATUS_UNOPENED"
              ? "STOPPED"
              : "UNKNOWN",
        externalId: row.remoteProductId,
        url: `https://mercari-shops.com/products/${encodeURIComponent(row.remoteProductId)}`,
        checkedAt: row.verifiedAt,
      };
    if (results[0].status === "fulfilled") catalog.channels.MERCARI_SHOPS = target;
  } else {
    delete catalog.channels.MERCARI_SHOPS;
    if (role === "ADMIN") catalog.errors.push("メルカリShopsの出品情報を取得できませんでした。");
  }
  if (results[3].status === "fulfilled") {
    const active = new Set(results[3].value.filter((r) => !r.deletedAt).map((r) => r.inventoryId));
    catalog.archivedIds = results[3].value
      .filter((r) => r.deletedAt && !active.has(r.inventoryId))
      .map((r) => r.inventoryId);
  } else catalog.errors.push("EC商品情報の削除状態を取得できませんでした。");
  let workflows:EconveniWorkflow[]=[];
  try{
    workflows=await readEconveniCatalog(inventoryId);
    for(const row of workflows){
      for(const channel of ['YAHOO','MERCARI_SHOPS'] as const){
        const c=row.channels[channel];
        const state:EcState=['PENDING','VERIFY_REQUIRED'].includes(c.state)||['PENDING','VERIFY_REQUIRED'].includes(row.save.state)?'ERROR':c.remoteStatus==='ACTIVE'?'ACTIVE':c.remoteStatus==='INACTIVE'?'STOPPED':'DRAFT';
        catalog.channels[channel]??={};
        catalog.channels[channel]![row.inventoryId]={state,externalId:c.listingId??null,url:c.listingUrl??null,checkedAt:row.updatedAt};
      }
    }
  }catch{
    delete catalog.channels.YAHOO;delete catalog.channels.MERCARI_SHOPS;
    catalog.errors.push('eコンビニの保存・出品情報を取得できませんでした。再読み込みしてください。');
  }
  try {const manual=await readManualSync(inventoryId);
    // Existing product-save bindings also take part in the same read-only observation.
    const links=[...manual.links];
    for(const workflow of workflows){
      const product=manual.snapshot?.products.find(p=>p.productId===workflow.save.productId);
      if(!product||links.some(l=>l.inventoryId===workflow.inventoryId))continue;
      links.push({inventoryId:workflow.inventoryId,productId:product.productId,inventoryName:product.title,remoteTitle:product.title,
        linkedAt:workflow.updatedAt,actor:'',baseline:product.channels,revision:workflow.revision});
    }
    overlayManualStatuses(catalog,{...manual,links});await overlayManualStops(catalog,manual,inventoryId);
    if(!inventoryId){
      const [remote,sold]=await Promise.allSettled([remoteOverview(manual,workflows),soldListingReferences()]);
      if(remote.status==='fulfilled')catalog.econveni=remote.value;else catalog.errors.push('eコンビニ一覧の在庫情報を読み込めませんでした。再読込してください。');
      if(sold.status==='fulfilled')catalog.soldListings=sold.value;else catalog.errors.push('売却先の確認情報を読み込めませんでした。操作前に売却管理を確認してください。');
    }
  }
  catch {catalog.errors.push('eコンビニの手動連携情報を取得できませんでした。状態を再確認してください。');}
  return catalog;
}
