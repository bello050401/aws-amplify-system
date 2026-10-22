export type OutboundColumn = { key: 'sku'|'barcode'|'name'|'quantity'|'unit'|'width'|'depth'|'height'|'location'; label:string };
export interface OutboundDestination {id:string; name:string; categoryId:string; locationId:string; isActive:boolean; sortOrder:number; sender:string; template:OutboundColumn[]; fileNamePattern:string; preparationStatus?:'ON_HOLD'|'WAITING_TEMPLATE'|'READY'; slackChannelId?:string|null;updatedAt?:string;templateType?:string;emailTo?:string;emailFrom?:string}
export interface OutboundProduct {id:string;sku:string;name:string;exportName?:string;barcode:string;quantity:number;unit:string;updatedAt:string;thumbnailUrl?:string|null;mergedIntoInventoryId?:string;mergedIntoSku?:string;mergeQuantityBefore?:number;mergeQuantityAfter?:number;location:string;[key:string]:unknown}
export interface OutboundSelection {id:string;updatedAt:string;quantity?:number;detailNote?:string;exportName?:string}
export interface OutboundRow {arrivalStatus?:string;arrivalAt?:string;arrivalBy?:string;arrivalError?:string;arrivalChanges?:unknown;id:string;inventoryId:string;batchId:string;status:'PENDING'|'SENT'|'SKIPPED'|'CANCELLED';snapshot:OutboundProduct;error?:string;expectedUpdatedAt?:string;sentAt?:string;sentBy?:string;sourceQuantity?:number;detailNote?:string;splitInventoryId?:string;splitSku?:string;splitImages?:unknown;splitPrepared?:boolean}
export interface OutboundBatch {arrivalWorkflow?:string;arrivalStatus?:string;arrivalAt?:string;arrivalBy?:string;arrivalCommandId?:string;arrivalPlan?:unknown;id:string;destinationId:string;destinationName:string;categoryId:string;locationId:string;status:string;requestedBy:string;fingerprint:string;template:OutboundColumn[];fileName:string;sender:string;createdAt:string;updatedAt?:string;rows:OutboundRow[];arrivalDate?:string;orderNumber?:string;templateType?:string;emailTo?:string;emailFrom?:string;emailStatus?:string;emailMessageId?:string;emailError?:string}
export function outboundStatusLabel(status:string):string {
  return ({PREPARING:'作成途中',AWAITING_SEND:'送信待ち',SENDING:'メール送信中',SEND_UNKNOWN:'メール送信結果の確認が必要',APPLYING:'出庫の完了処理中',PARTIAL:'出庫の完了処理が未完了',COMPLETED:'完了',CANCELLING:'取消処理中',CANCELLED:'取消済み'} as Record<string,string>)[status]??'状態を確認してください';
}
export function outboundRowLabel(row:OutboundRow,batchStatus:string):string {
  if(row.status==='PENDING'&&['PARTIAL','APPLYING'].includes(batchStatus))return '送信記録済み・完了処理が未完了';
  return {SENT:'送信済み',PENDING:'送信待ち',CANCELLED:'取消済み',SKIPPED:'除外'}[row.status];
}
export const DEFAULT_OUTBOUND_COLUMNS:OutboundColumn[]=[{key:'sku',label:'管理番号'},{key:'barcode',label:'QRコード・バーコード'},{key:'name',label:'商品名'},{key:'quantity',label:'数量'},{key:'unit',label:'単位'},{key:'width',label:'幅(cm)'},{key:'depth',label:'奥行(cm)'},{key:'height',label:'高さ(cm)'},{key:'location',label:'移動前の保管場所'}];
export function exportProductName(row:OutboundProduct):string{return row.exportName ?? row.name;}
export function outboundCsv(rows:OutboundProduct[],columns:OutboundColumn[]):string {
  const escape=(value:unknown)=>{let text=String(value??'');if(/^[\s]*[=+@-]/u.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
  return '\ufeff'+[columns.map(col=>escape(col.label)).join(','),...rows.map(row=>columns.map(col=>escape(col.key==='name'?exportProductName(row):row[col.key])).join(','))].join('\r\n')+'\r\n';
}
export function parseJsonField<T>(value:unknown,fallback:T):T {
  if(typeof value==='string'){try{return JSON.parse(value) as T;}catch{return fallback;}}
  return (value??fallback) as T;
}
