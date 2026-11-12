import type {EcCatalog,EcChannel,EcChannelState} from '../ecManagement';

export type ExternalStatus = {state:'ACTIVE'|'INACTIVE'|'EXCLUDED';listingId:string|null;listingUrl:string|null};
export type ExternalProduct = {productId:string;title:string;imageUrl:string|null;quantity:number;price:number;inventoryMarker:string|null;channels:Record<EcChannel,ExternalStatus>};
export type ExternalSnapshot = {version:string;checkedAt:string;products:ExternalProduct[]};
export type ManualLink = {pk?:string;relatedProductIds?:string[];inventoryId:string;productId:string;inventoryName:string;remoteTitle:string;linkedAt:string;actor:string;baseline:Record<EcChannel,ExternalStatus>;revision:number;disabled?:boolean};
export type ManualSyncData = {snapshot:ExternalSnapshot|null;links:ManualLink[]};
export const manualLinkKey=(link:ManualLink)=>link.pk??'ECONVENI#MANUAL_LINK#'+link.inventoryId;
/** A stock item may have different e-conveni pages for different marketplaces. */
export function selectManualLink(data:ManualSyncData,id:string,channel?:EcChannel):ManualLink|undefined {
 const links=data.links.filter(l=>!l.disabled&&l.inventoryId===id);
 if(!channel)return links.find(l=>manualLinkKey(l)==='ECONVENI#MANUAL_LINK#'+id)??links[0];
 const state=(l:ManualLink)=>data.snapshot?.products.find(p=>p.productId===l.productId)?.channels[channel]??l.baseline[channel];
 const active=links.filter(l=>state(l).state==='ACTIVE');
 if(active.length>1)throw Error('同じ販売先に複数の出品があります。EC出品のeコンビニ一覧から対象ページを選択してください。');
 if(active.length)return active[0];
 const numbered=links.filter(l=>state(l).listingId);
 if(numbered.length>1)throw Error('同じ販売先に複数の出品番号があります。EC出品のeコンビニ一覧から対象ページを選択してください。');
 return numbered[0]??selectManualLink(data,id);
}
export const normalTitle=(value:string)=>value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
/** Candidate comparison only. Never use this value to rename inventory or an external listing. */
export const titleWithoutNotes=(value:string)=>value.replace(/【[^【】]*】/gu,'');
export function differentTitleNotes(left:string,right:string):boolean {
 const notes=(value:string)=>[...new Set(Array.from(value.matchAll(/【([^【】]*)】/gu),m=>normalTitle(m[1])).filter(Boolean))].sort().join('\n');
 return notes(left)!==notes(right);
}
export function sameTitleWithoutNotes(left:string,right:string):boolean {
 const a=normalTitle(titleWithoutNotes(left)),b=normalTitle(titleWithoutNotes(right));
 return !!a&&a===b;
}
/** Pasting a BELLO title with internal notes can find the external title without those notes. */
export function productTitleMatchesQuery(title:string,identifier:string,query:string):boolean {
 if(!query.trim())return true;
 const raw=normalTitle(query),bare=normalTitle(titleWithoutNotes(query));
 // An empty/notes-only comparison must not match every product. Explicit memo searches still work.
 const words=titleWithoutNotes(query).normalize('NFKC').trim().split(/\s+/).map(normalTitle).filter(Boolean);
 return !!raw&&(normalTitle(title).includes(raw)||normalTitle(identifier).includes(raw))
  ||!!bare&&normalTitle(titleWithoutNotes(title)).includes(bare)
  ||words.length>1&&words.every(word=>normalTitle(titleWithoutNotes(title)).includes(word));
}
/** Ranking proposes candidates only; neither a name nor a picture automatically binds stock. */
export function titleSimilarity(left:string,right:string):number {
 const a=normalTitle(titleWithoutNotes(left)),b=normalTitle(titleWithoutNotes(right));if(!a||!b)return 0;if(a===b)return 1;
 const grams=(s:string)=>new Set(Array.from({length:Math.max(0,s.length-1)},(_,i)=>s.slice(i,i+2)));
 const x=grams(a),y=grams(b);return x.size+y.size?2*[...x].filter(v=>y.has(v)).length/(x.size+y.size):0;
}
export function observedChannel(product:ExternalProduct|null,channel:EcChannel,link:ManualLink,checkedAt:string):EcChannelState {
 const baseline=link.baseline[channel],current=product?.channels[channel];
 // An observed cleared ID is authoritative. Do not resurrect it from the link baseline.
 const id=current?current.listingId:baseline.listingId,url=current?current.listingUrl:baseline.listingUrl;
 // 「未」は観測された通常状態。削除・停止の成功証明とは区別し、失敗扱いにしない。
 // 未確認の停止命令は overlayManualStops が別途 ERROR として維持する。
 const note=!product?'eコンビニで商品を確認できません。削除・停止とは断定していません。':current?.state==='EXCLUDED'?'eコンビニで「対象外」です。出品停止とは異なります。':undefined;
 return {state:note?'ERROR':current?.state==='ACTIVE'?'ACTIVE':current?.listingId?'STOPPED':'UNLISTED',externalId:id,url,checkedAt,note,source:'ECONVENI'};
}
/** Observations cannot overwrite a newer BELLO command, or an unresolved send. */
export function overlayManualStatuses(catalog:EcCatalog,data:ManualSyncData):EcCatalog {
 if(!data.snapshot)return catalog;
 const products=new Map(data.snapshot.products.map(p=>[p.productId,p]));
 for(const id of new Set(data.links.filter(l=>!l.disabled).map(l=>l.inventoryId))){
  for(const channel of ['YAHOO','MERCARI_SHOPS','BASE'] as const){
   const own=catalog.channels[channel]?.[id];
   if(own&&own.source!=='ECONVENI'&&(own.state==='PENDING'||own.state==='ERROR'||own.checkedAt&&own.checkedAt>data.snapshot.checkedAt))continue;
   catalog.channels[channel]??={};
   try{const link=selectManualLink(data,id,channel)!;catalog.channels[channel]![id]=observedChannel(products.get(link.productId)??null,channel,link,data.snapshot.checkedAt);}
   catch(e){catalog.channels[channel]![id]={state:'ERROR',externalId:null,url:null,checkedAt:data.snapshot.checkedAt,note:(e as Error).message,source:'ECONVENI'};}
  }
 }
 return catalog;
}
