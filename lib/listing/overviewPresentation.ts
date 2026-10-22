import type {ListingOverviewRow} from './service';
import {commonChannelPrice} from './commonSettings';
import {EC_CHANNELS,type EcChannel} from './ecManagement';
export type EcSortKey='name'|'quantity'|'price'|'created'|'updated'|EcChannel;
export function ecOverviewPrice(row:ListingOverviewRow,channel:EcChannel){return row.hasDraft||row.archived?commonChannelPrice({price:row.price,channelPrices:row.channelPrices??null},channel):null;}
export function compareEcOverview(a:ListingOverviewRow,b:ListingOverviewRow,key:EcSortKey,direction:'asc'|'desc'){
 const sign=direction==='asc'?1:-1;
 const value=(r:ListingOverviewRow):string|number|null=>key==='name'?r.name:key==='quantity'?r.quantity:key==='price'?r.price:key==='created'?(r.inventoryCreatedAt?Date.parse(r.inventoryCreatedAt):null):key==='updated'?Date.parse(r.inventoryUpdatedAt):EC_CHANNELS.includes(key as EcChannel)?ecOverviewPrice(r,key as EcChannel):null;
 const av=value(a),bv=value(b),missing=(v:unknown)=>v==null||typeof v==='number'&&!Number.isFinite(v);
 if(missing(av)||missing(bv))return missing(av)===missing(bv)?a.inventoryId.localeCompare(b.inventoryId):missing(av)?1:-1;
 const diff=typeof av==='string'&&typeof bv==='string'?av.localeCompare(bv,'ja'):Number(av)-Number(bv);
 return sign*(diff||a.displayId.localeCompare(b.displayId,'en',{numeric:true}))||a.inventoryId.localeCompare(b.inventoryId);
}
