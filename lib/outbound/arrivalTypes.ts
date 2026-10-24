import type {OutboundBatch,OutboundRow} from './types';

export type ArrivalStatus='WAITING'|'APPLYING'|'PARTIAL'|'COMPLETED';
export interface ArrivalChange {rowId:string;inventoryId:string;expectedUpdatedAt:string;locationId:string;categoryIds:string[]}
export interface ArrivalProduct {
 rowId:string;inventoryId:string;sku:string;name:string;quantity:number;updatedAt:string;
 locationId:string;categoryIds:string[];defaultCategoryIds:string[];error?:string;
}
export interface ArrivalPreview {
 batch:OutboundBatch;items:ArrivalProduct[];
 categories:{id:string;name:string}[];locations:{id:string;name:string}[];
}
export interface OutboundHistoryEntry {id:string;createdAt:string;dispatchedAt?:string;destinationName:string;status:string;arrivalStatus?:ArrivalStatus;productCount:number;quantity:number;arrivalCompletedCount:number}
export function isArrivalRow(row:OutboundRow){return row.status==='SENT'&&row.snapshot.classificationPreserved===true&&!row.snapshot.mergedIntoInventoryId;}
/** A historical movement that already changed stock must never be applied again. */
export function arrivalStatus(batch:OutboundBatch):ArrivalStatus|undefined {
 const rows=batch.rows.filter(isArrivalRow);
 if(!rows.length)return undefined;
 if(rows.every(row=>row.arrivalStatus==='COMPLETED'))return batch.arrivalStatus==='COMPLETED'?'COMPLETED':'APPLYING';
 if(batch.arrivalStatus==='APPLYING')return 'APPLYING';
 if(batch.arrivalStatus==='PARTIAL'||rows.some(row=>row.arrivalStatus==='COMPLETED'))return 'PARTIAL';
 return 'WAITING';
}
export function arrivalLabel(status?:string){return ({WAITING:'出庫済み・到着確認待ち',APPLYING:'在庫情報を更新中',PARTIAL:'一部未完了・確認が必要',COMPLETED:'到着確認済み・更新完了'} as Record<string,string>)[status??'']??'';}

export function arrivalFailureMessage(error:unknown){
 const failure=error as {name?:string;message?:string}|null;
 if(failure?.name==='AccessDeniedException')return 'システムの更新権限が不足しています。管理者による設定修正後に「更新を再開」してください。';
 if(failure?.message&&/商品が変更|保管場所またはカテゴリ/.test(failure.message))return failure.message;
 return '更新を確認できません。「更新を再開」で再確認してください。';
}
