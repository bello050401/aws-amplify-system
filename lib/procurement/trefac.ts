import {createHash} from 'node:crypto';
import {procurementPurchasePrice} from './pricing';
export const TREFAC_BOUNDARY={documentId:'bp4K1lfnmcnBQrgFIC7r',goodsId:5809352,lotNumber:85,earliest:'2026-11-13T00:32:41.164Z'} as const;
export type TrefacLot={account:string;documentId:string;goodsId:string;lotNumber:number;name:string;date:string;soldAt:string;sourceQuantity:number;pieces:number|null;quantity:number|null;hammerPrice:number;purchasePrice:number|null;purchaseTotal:number;imageUrl:string;description:string;issues:string[]};
export function trefacLot(row:Record<string,unknown>,account:string):TrefacLot{
 if(row.status!=='落札'||row.available!==true||row.return_requested===true||typeof row.count!=='number'||!Number.isSafeInteger(row.count)||row.count<1||typeof row.dispnum!=='number'||!Number.isInteger(row.dispnum)||typeof row.id!=='string'||!row.id||typeof row.label!=='string'||!row.label||typeof row.endprice!=='number'||!Number.isSafeInteger(row.endprice)||row.endprice<=0||typeof row.number!=='number'||!Number.isSafeInteger(row.number)||row.number<1||typeof row.saledate!=='string'||!Number.isFinite(Date.parse(row.saledate)))throw Error('落札結果・数量・金額を確認できない商品があります。');
 const name=String(row.label),matches=[...name.normalize('NFKC').matchAll(/(\d+)\s*(?:点|脚|台|個|枚|本)\s*セット/g)].map(m=>Number(m[1]));
 const issues:string[]=[];let pieces:number|null=1;
 if(matches.length&&new Set(matches).size===1&&matches[0]>0&&matches[0]<=10000)pieces=matches[0];
 else if(matches.length||/セット|一山|まとめ/.test(name)){pieces=null;issues.push('セットの点数を入力してください');}
 const purchaseTotal=procurementPurchasePrice('TREFAC',row.endprice*row.number);
 return{account,documentId:String(row.id),goodsId:String(row.count),lotNumber:row.dispnum,name,date:new Date(Date.parse(row.saledate)+9*3600000).toISOString().slice(0,10),soldAt:row.saledate,sourceQuantity:row.number,pieces,quantity:pieces?pieces*row.number:null,hammerPrice:row.endprice,purchasePrice:pieces?procurementPurchasePrice('TREFAC',row.endprice,pieces,true):null,purchaseTotal,imageUrl:Array.isArray(row.images)&&typeof row.images[0]==='string'?row.images[0]:'',description:typeof row.description==='string'?row.description:'',issues};
}
export function completeTrefacLot(lot:TrefacLot,pieces:number):TrefacLot{
 if(!Number.isSafeInteger(pieces)||pieces<1||pieces>10000||pieces*lot.sourceQuantity>100000)throw Error('1組あたりの在庫点数を正しく入力してください。');
 return{...lot,pieces,quantity:pieces*lot.sourceQuantity,purchasePrice:procurementPurchasePrice('TREFAC',lot.hammerPrice,pieces,true),issues:[]};
}
export function trefacInventoryId(lot:Pick<TrefacLot,'account'|'goodsId'>){const h=createHash('sha256').update('BELLO:TREFAC:'+lot.account+':'+lot.goodsId).digest('hex');return`${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
export function trefacAfterBoundary(row:Record<string,unknown>,anchor:Record<string,unknown>){
 const date=Date.parse(String(row.saledate)),boundary=Date.parse(String(anchor.saledate));
 return Number.isFinite(date)&&date>=boundary&&boundary===Date.parse(TREFAC_BOUNDARY.earliest);
}
