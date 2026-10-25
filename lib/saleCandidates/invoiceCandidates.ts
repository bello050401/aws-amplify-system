import {candidateKey} from './mailParser';
import type {SaleCandidate} from './model';
import type {Invoice} from '../invoicing/model';
export type InvoiceSaleLink={line:number;inventoryId:string};
export function invoiceLinks(raw:unknown,input:Invoice):InvoiceSaleLink[]{
 if(raw===undefined)return [];
 if(!Array.isArray(raw)||raw.length>50)throw Error('INVALID_LINKS');
 const indexes=new Set<number>();
 return raw.map(v=>{if(!v||!Number.isSafeInteger(v.line)||v.line<0||v.line>=input.lines.length||indexes.has(v.line)||typeof v.inventoryId!=='string'||!/^[\w-]{1,128}$/.test(v.inventoryId))throw Error('INVALID_LINKS');indexes.add(v.line);return {line:v.line,inventoryId:v.inventoryId};});
}
// No recipient, invoice number, edited line title or document is persisted here.
export function makeInvoiceCandidates(operation:string,input:Invoice,links:InvoiceSaleLink[],now=new Date().toISOString()):SaleCandidate[]{
 return links.map(link=>{const line=input.lines[link.line],q=Number(line.quantity),p=Number(line.price);return {id:candidateKey('INVOICE',operation,String(link.line)),state:'PENDING',channel:'DIRECT',source:'INVOICE',name:'',quantity:Number.isSafeInteger(q)?q:null,unitPrice:Number.isSafeInteger(p)?p:null,orderId:'',identifierType:'INVOICE',saleDate:input.date,receivedAt:now,createdAt:now,updatedAt:now,suggestedInventoryId:link.inventoryId,shipping:null,orderTotal:null,payment:'',warnings:['請求書は発行済みです。代金受領・引渡しを確認してから売却を確定してください。'],orderLineCount:links.length};});
}
