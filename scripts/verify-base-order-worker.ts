import {test} from 'node:test';
import assert from 'node:assert/strict';
import {baseAccessToken} from '../lib/base/tokenStore';
import {importBaseOrdersCore} from '../lib/saleCandidates/baseImportCore';

function tokenDb(){let row:any={id:'singleton',accessToken:'expired',refreshToken:'refresh1',expiresAt:'2020-01-01'};return {read:()=>row,db:{send:async(c:any)=>{const p=c.input,v=p.ExpressionAttributeValues;
 if(c.constructor.name==='GetCommand')return {Item:structuredClone(row)};
 if(p.UpdateExpression.startsWith('SET refreshOwner')){if(row.refreshOwner||row.refreshBlocked||row.refreshToken!==v[':r'])throw Object.assign(Error('locked'),{name:'ConditionalCheckFailedException'});row.refreshOwner=v[':o'];row.refreshLeaseUntil=v[':e'];}
 else if(p.UpdateExpression.startsWith('SET accessToken')){assert.equal(row.refreshOwner,v[':o']);assert.equal(row.refreshToken,v[':old']);row.accessToken=v[':a'];row.refreshToken=v[':r'];row.expiresAt=v[':e'];delete row.refreshOwner;delete row.refreshLeaseUntil;}
 else {assert.equal(row.refreshOwner,v[':o']);row.refreshBlocked=true;delete row.refreshOwner;}return {};
 }} as any};}
const credentials=async()=>({clientId:'test-client',clientSecret:'test-secret'});
test('web and scheduled worker cannot rotate the same token twice',async()=>{
 const m=tokenDb();let calls=0,release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const transport=async()=>{calls++;await gate;return Response.json({access_token:'fresh',refresh_token:'refresh2',expires_in:3600});};
 const first=baseAccessToken(m.db,'tokens',credentials,transport as any);await new Promise(r=>setImmediate(r));
 await assert.rejects(baseAccessToken(m.db,'tokens',credentials,transport as any),/BASE_TOKEN_BUSY/);release();assert.equal(await first,'fresh');
 assert.equal(await baseAccessToken(m.db,'tokens',credentials,transport as any),'fresh');assert.equal(calls,1);assert.equal(m.read().refreshToken,'refresh2');
});
test('lost refresh response is never retried with a potentially consumed token',async()=>{const m=tokenDb();let calls=0;const send=async()=>{calls++;throw Error('response lost');};await assert.rejects(baseAccessToken(m.db,'t',credentials,send as any));await assert.rejects(baseAccessToken(m.db,'t',credentials,send as any));assert.equal(calls,1);assert.equal(m.read().refreshBlocked,true);});

function orderDb(){const rows=new Map<string,any>();const db={send:async(c:any)=>{const p=c.input,v=p.ExpressionAttributeValues;
 switch(c.constructor.name){case 'GetCommand':return {Item:rows.get(p.Key.id)};case 'PutCommand':rows.set(p.Item.id,structuredClone(p.Item));return {};
 case 'UpdateCommand':if(p.Key.id==='BASE_IMPORT_LOCK'){if(v[':e']){if(rows.get(p.Key.id)?.expiresAt>Date.now())throw Object.assign(Error('locked'),{name:'ConditionalCheckFailedException'});rows.set(p.Key.id,{ownerId:v[':o'],expiresAt:v[':e']});}else rows.set(p.Key.id,{expiresAt:0});}return {};
 case 'ScanCommand':return {Items:[...rows.values()].filter(x=>x.channel==='BASE'&&x.orderId===v[':o'])};
 case 'TransactWriteCommand':for(const x of p.TransactItems)assert(!rows.has(x.Put.Item.id),'duplicate transaction');for(const x of p.TransactItems)rows.set(x.Put.Item.id,structuredClone(x.Put.Item));return {};
 default:throw Error(c.constructor.name);
 }}} as any;return {db,rows};}
const order={unique_key:'new-order',ordered:1792890000,shipping_fee:0,total:2000,payment:'creditcard',fee_type:'base',order_items:[{item_id:123,order_item_id:456,title:'test chair',price:1000,amount:2}]};
test('BASE imports exact item IDs once; repeated retrieval cannot create duplicates',async()=>{const m=orderDb();let details=0;const read=async(url:string)=>{if(url.includes('/detail/')){details++;return Response.json({order});}return Response.json({orders:[{unique_key:order.unique_key}]});};const first=await importBaseOrdersCore(m.db,'t',async()=>'opaque',read as any);assert.equal(first.created,1);assert.equal(details,1);m.rows.delete('BASE_IMPORT_STATUS');const again=await importBaseOrdersCore(m.db,'t',async()=>'opaque',read as any);assert.equal(again.created,0);assert.equal(details,1);assert.equal([...m.rows.values()].find(x=>x.source==='BASE_API').externalListingId,'123');});
test('previous email candidate prevents duplicate API order and no buyer fields are retained',async()=>{const m=orderDb();m.rows.set('legacy',{id:'legacy',channel:'BASE',orderId:'new-order'});let details=0;const r=await importBaseOrdersCore(m.db,'t',async()=>'opaque',(async(url:string)=>{if(url.includes('/detail/'))details++;return Response.json({orders:[{unique_key:'new-order'}]});}) as any);assert.equal(r.created,0);assert.equal(details,0);assert(!JSON.stringify([...m.rows.values()]).includes('opaque'));});
test('permission failure remains visible and cannot be reported as success',async()=>{const m=orderDb();const r=await importBaseOrdersCore(m.db,'t',async()=>'opaque',(async()=>new Response('',{status:403})) as any);assert.equal(r.ok,false);assert.equal(m.rows.get('BASE_IMPORT_STATUS').error,'BASE_ORDERS_AUTH_REQUIRED');assert.equal(m.rows.get('BASE_IMPORT_LOCK').expiresAt,0);});
test('BASE HTTP 400 invalid_scope asks for order authorization, not a generic retry',async()=>{const m=orderDb();const r=await importBaseOrdersCore(m.db,'t',async()=>'opaque',(async()=>Response.json({error:'invalid_scope'},{status:400})) as any);assert.equal(r.ok,false);assert.equal(m.rows.get('BASE_IMPORT_STATUS').error,'BASE_ORDERS_AUTH_REQUIRED');});
