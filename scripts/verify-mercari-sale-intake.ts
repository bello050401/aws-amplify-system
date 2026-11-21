import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePurchaseMail,type PurchaseMail} from '../lib/saleCandidates/mailParser';
import {mercariOrderIdentity,mergeMercariNotification} from '../lib/saleCandidates/mercariMailIdentity';
import {createCandidateStore} from '../lib/saleCandidates/storeCore';
import {mercariSenderAuthenticated} from '../lib/saleCandidates/mailAuthentication';

const shop='FixtureShop12345678',order='FixtureOrder12345678';
const url=`https://mercari-shops.com/seller/shops/${shop}/orders/${order}`;
const mail:PurchaseMail={gmailId:'test-only',from:'no-reply@mercari-shops.com',subject:'【メルカリShops】「検証用の椅子」の発送をお願いします。',receivedAt:'2026-11-21T00:00:00Z',authenticatedMercariSender:true,text:`商品の発送をお願いします。\n商品名 : 検証用の椅子\n商品価格 : ¥12,000\n数量 : 1\n注文番号 : order_${order}\n送料 : ¥0\n合計金額 : ¥12,000\n${url}?source=deeplink\n▼配送先情報\nPRIVATE CUSTOMER`};
test('observed seller-order notification retains safe canonical order URL, never treats order as listing ID',()=>{
 const [c]=parsePurchaseMail(mail);assert.equal(c.mercariOrderUrl,url);assert.equal(c.mercariShopId,shop);assert.equal(c.externalListingId,undefined);assert.equal(c.quantity,1);assert.equal(c.unitPrice,12000);assert.equal(c.orderId,'order_'+order);assert.equal(JSON.stringify(c).includes('PRIVATE'),false);
});
test('HTML href is inspected even when plain text exists and repeated same order URLs are one identity',()=>{
 const m={...mail,text:mail.text!.replace(url+'?source=deeplink',''),html:`<a href="${url}?source=deeplink&amp;other=1">注文</a><a href="${url}">注文</a>`};
 assert.equal(parsePurchaseMail(m)[0].mercariOrderUrl,url);
});
test('untrusted/mismatched/ambiguous/foreign-host order links do not resolve',()=>{
 for(const m of [
  {...mail,authenticatedMercariSender:false},
  {...mail,text:mail.text!.replace(order,order+'X')},
  {...mail,text:mail.text+'\n'+url.replace(order,'OtherOrder12345678')},
  {...mail,text:mail.text!.replace('mercari-shops.com/','mercari-shops.com.evil.invalid/')},
  {...mail,text:mail.text!.replace('https://mercari-shops.com','https://user@mercari-shops.com')},
  {...mail,text:mail.text!.replace('https://','http://')},
 ])assert.equal(parsePurchaseMail(m)[0].mercariOrderUrl,undefined);
 assert.equal(mercariOrderIdentity(mail,'order_MISMATCH12345678'),null);
});
test('multiple order lines remain reviewable, do not attach one order proof to all products',()=>{
 const [a,b]=parsePurchaseMail({...mail,text:mail.text+'\n商品名 : 別の検証商品\n商品価格 : ¥1,000\n数量 : 1'});assert.notEqual(a.id,b.id);assert.equal(a.mercariOrderUrl,undefined);assert.equal(b.mercariOrderUrl,undefined);
});
test('authenticated repeat enriches v3 pending candidate preserving id and received/created times',()=>{
 const fresh=parsePurchaseMail(mail)[0],old={...fresh};delete old.mercariOrderUrl;delete old.mercariShopId;
 const next=mergeMercariNotification(old,fresh);assert.equal(next.id,old.id);assert.equal(next.createdAt,old.createdAt);assert.equal(next.receivedAt,old.receivedAt);assert.equal(next.mercariOrderUrl,url);assert.notEqual(next.updatedAt,old.updatedAt);
 assert.equal(mergeMercariNotification(next,fresh),next);
});
test('completed/deleted/archived and conflicting authenticated facts cannot be overwritten',()=>{
 const fresh=parsePurchaseMail(mail)[0];
 for(const state of ['DONE','DELETED','ARCHIVED'] as const){const current={...fresh,state};assert.equal(mergeMercariNotification(current,fresh),current);}
 for(const changed of [{quantity:2},{unitPrice:13000},{name:'別商品'},{shipping:1000},{orderTotal:24000},{mercariOrderUrl:url+'X'}]){const current={...fresh,...changed};assert.equal(mergeMercariNotification(current,fresh),current);}
 assert.equal(mergeMercariNotification(fresh,{...fresh,senderAuthenticated:false}),fresh);
});
test('forged untrusted first notification cannot suppress later receiving-server authenticated facts',()=>{
 const fresh=parsePurchaseMail(mail)[0],old={...fresh,name:'forged',unitPrice:1,senderAuthenticated:false};delete old.mercariOrderUrl;
 const next=mergeMercariNotification(old,fresh);assert.equal(next.name,fresh.name);assert.equal(next.unitPrice,12000);assert.equal(next.senderAuthenticated,true);assert.equal(next.id,old.id);
});
test('concurrent sale commit during Mercari enrichment wins and enrichment never resets DONE',async()=>{
 const fresh=parsePurchaseMail(mail)[0],old={...fresh};delete old.mercariOrderUrl;let row=old,writes=0;
 const db={send:async(command:any)=>{if(command.constructor.name==='GetCommand')return {Item:structuredClone(row)};writes++;if(writes===1){row={...row,state:'DONE'};throw Object.assign(Error('conflict'),{name:'ConditionalCheckFailedException'});}throw Error('Must not overwrite committed sale');}};
 assert.equal(await createCandidateStore(db as never,'SaleTable').receiveMercari(fresh),'unchanged');assert.equal(row.state,'DONE');assert.equal(writes,1);
});
test('Gmail DMARC sender authentication rejects spoofed or foreign authentication evidence',()=>{
 const header=(value:string)=>[{name:'Authentication-Results',value}];
 assert.equal(mercariSenderAuthenticated(header('mx.google.com; dmarc=pass header.from=mercari-shops.com')),true);
 for(const v of ['attacker.invalid; dmarc=pass header.from=mercari-shops.com','mx.google.com; dmarc=fail header.from=mercari-shops.com','mx.google.com; dmarc=pass header.from=mercari-shops.com.evil.invalid','mx.google.com; dmarc=pass header.from=evil.invalid'])assert.equal(mercariSenderAuthenticated(header(v)),false);
 assert.deepEqual(parsePurchaseMail({...mail,from:'no-reply@mercari-shops.com <evil@example.invalid>'}),[]);
});
