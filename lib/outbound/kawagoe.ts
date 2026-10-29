import iconv from 'iconv-lite';
import {exportProductName} from './types';
import type {OutboundBatch,OutboundRow} from './types';

export const KAWAGOE_TEMPLATE='KAWAGOE_V1';
export const PRODUCT_HEADERS=['商品コード','JANコード','商品名'];
export const ARRIVAL_HEADERS=['発注番号','入荷予定日','商品コード','入荷予定数','ヘッダ備考','入荷明細備考'];
export function validateArrivalDate(value:unknown):asserts value is string {
 if(typeof value!=='string'||!/^20\d{2}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw Error('入荷予定日を選択してください。');
}
export function orderNumber(date:string,sequence:number){validateArrivalDate(date);return `${date.replaceAll('-','')}入荷_${sequence}`;}
export function validateMovementQuantity(value:unknown,available:number):asserts value is number {
 if(typeof value!=='number'||!Number.isInteger(value)||value<1||value>available)throw Error(`出庫数量は1〜${available}点で入力してください。`);
}
export function validateBarcode(value:unknown):string {
 const code=typeof value==='string'?value.trim():'';
 if(!code||code.length>256||/[\u0000-\u0020\u007f]/u.test(code)||/^[=+@-]/u.test(code))throw Error('商品コードに使うQRコード・バーコードの値を確認してください。');
 return code;
}
function csv(lines:unknown[][]):Buffer {
 const text=lines.map(row=>row.map(value=>{const s=String(value??'');if(/^[\s]*[=+@-]/u.test(s))throw Error('CSVの先頭に数式記号は使用できません。');return /[",\r\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;}).join(',')).join('\r\n')+'\r\n';
 const bytes=iconv.encode(text,'cp932');
 // The warehouse expects Shift-JIS. Do not silently corrupt names or remarks.
 if(iconv.decode(bytes,'cp932')!==text)throw Error('商品名または明細備考に、川越用CSVで使用できない文字があります。絵文字などを取り除いてください。');
 return bytes;
}
export interface OutboundAttachment {fileName:string;data:Buffer;kind:'products'|'arrival'}
export function kawagoeAttachments(batch:OutboundBatch):OutboundAttachment[] {
 if(batch.templateType!==KAWAGOE_TEMPLATE||!batch.orderNumber)throw Error('川越の送信データを確認してください。');
 validateArrivalDate(batch.arrivalDate);
 const rows=batch.rows.filter(row=>row.status==='PENDING'||row.status==='SENT');
 if(!rows.length)throw Error('送信できる商品がありません。');
 const products=new Map<string,OutboundRow>();
 for(const row of rows){const code=validateBarcode(row.snapshot.barcode);validateMovementQuantity(row.snapshot.quantity,row.sourceQuantity??row.snapshot.quantity);if(!exportProductName(row.snapshot))throw Error('在庫数表記以外の送信用の商品名を入力してください。');if(products.has(code)&&exportProductName(products.get(code)!.snapshot)!==exportProductName(row.snapshot))throw Error('同じバーコードに異なる商品名があります。対象商品を確認してください。');products.set(code,row);}
 const suffix=batch.orderNumber.replace('入荷','');
 const total=rows.reduce((sum,row)=>sum+row.snapshot.quantity,0);
 return [
  {kind:'products',fileName:`Bello_商品マスタ取込CSV_${suffix}.csv`,data:csv([PRODUCT_HEADERS,...[...products].map(([code,row])=>[code,code,exportProductName(row.snapshot)])])},
  {kind:'arrival',fileName:`${suffix}入荷予定（計${total}点）.csv`,data:csv([ARRIVAL_HEADERS,...rows.map(row=>[batch.orderNumber,batch.arrivalDate!.replaceAll('-','/'),validateBarcode(row.snapshot.barcode),row.snapshot.quantity,'',row.detailNote??''])])},
 ];
}
