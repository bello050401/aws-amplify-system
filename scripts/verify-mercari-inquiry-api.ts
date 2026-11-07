import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createMercariInquiryClient,MercariInquiryError} from '../lib/messaging/mercari/inquiryAdapter';
const credentials={accessToken:'test-only',clientName:'TEST',shopId:'shop-test'};
const row=(id:string,from='BUYER',status='ACTIVE')=>({id,inquiryId:'inquiry-test',body:'TEST',from,sentAt:'2026-11-08T00:00:00Z',status,attachments:[]});
function transport(responses:unknown[],seen:Record<string,unknown>[]=[]):typeof fetch{
 return (async(input,init)=>{
  assert.equal(input,'https://api.mercari-shops.com/v1/graphql');
  assert.equal(init?.redirect,'error');assert.equal(init?.cache,'no-store');
  seen.push(JSON.parse(String(init?.body)));
  const next=responses.shift();if(next instanceof Error)throw next;
  return new Response(JSON.stringify(next),{status:200,headers:{'content-type':'application/json'}});
 }) as typeof fetch;
}
const account={data:{shop:{id:'shop-test'}}};
const detail={data:{inquiry:{id:'inquiry-test',lastActivityAt:'2026-11-08T00:00:00Z',status:'AWAITING_SELLER',target:{__typename:'InquiryProductTarget',productId:'deleted-product-id'}}}};
const batch=(rows:unknown[],after:string|null=null)=>({data:{inquiryMessages:{edges:rows.map(node=>({node})),pageInfo:{hasNextPage:!!after,endCursor:after}}}});
test('正しいアカウントを確認し全ページを取得、削除商品IDも保持',async()=>{
 const seen:Record<string,unknown>[]=[];
 const client=createMercariInquiryClient(credentials,transport([account,detail,batch([row('m2')],'next'),batch([row('m1'),row('m2')])],seen));
 const r=await client.read('inquiry-test');assert.equal(r.messages.length,2);assert.equal(r.inquiry.target.productId,'deleted-product-id');assert.equal(seen.length,4);assert.deepEqual(seen[3].variables,{id:'inquiry-test',after:'next'});
});
test('他のアカウントでは本文を取得しない',async()=>{
 const seen:Record<string,unknown>[]=[];const c=createMercariInquiryClient(credentials,transport([{data:{shop:{id:'wrong'}}}],seen));
 await assert.rejects(()=>c.read('inquiry-test'),e=>e instanceof MercariInquiryError&&e.code==='ACCOUNT_MISMATCH');assert.equal(seen.length,1);
});
test('別問い合わせの混入を拒否',async()=>{
 const c=createMercariInquiryClient(credentials,transport([account,detail,batch([{...row('m1'),inquiryId:'other'}])]));
 await assert.rejects(()=>c.read('inquiry-test'),/INVALID_MESSAGE/);
});
test('ページの繰返し・途中終了を正常完了にしない',async()=>{
 const c=createMercariInquiryClient(credentials,transport([account,detail,batch([row('m1')],'same'),batch([row('m1')],'same')]));
 await assert.rejects(()=>c.read('inquiry-test'),/CURSOR_LOOP/);
});
test('ブロック・削除済みの本文と画像を空にする',async()=>{
 const c=createMercariInquiryClient(credentials,transport([account,detail,batch([{...row('m1','BUYER','ADMIN_DELETED'),attachments:[{url:'https://example.com/a.jpg'}]}])]));
 const r=await c.read('inquiry-test');assert.equal(r.messages[0].body,'');assert.deepEqual(r.messages[0].attachments,[]);
});
test('下書き評価中の送信は接続前に拒否',async()=>{
 const seen:Record<string,unknown>[]=[];const c=createMercariInquiryClient(credentials,transport([],seen));
 await assert.rejects(()=>c.send('inquiry-test','TEST','00000000-0000-4000-8000-000000000000',async()=>true),/DELIVERY_DISABLED/);assert.equal(seen.length,0);
});
test('外部エラーの本文をログ・例外に出さない',async()=>{
 const c=createMercariInquiryClient(credentials,transport([{errors:[{message:'personal-secret'}]}]));
 await assert.rejects(()=>c.verifyAccount(),e=>e instanceof MercariInquiryError&&e.message==='REMOTE_REJECTED'&&!e.message.includes('personal-secret'));
});
test('不正IDは通信しない',async()=>{const seen:Record<string,unknown>[]=[];const c=createMercariInquiryClient(credentials,transport([],seen));await assert.rejects(()=>c.read('../wrong'),/INVALID_ID/);assert.equal(seen.length,0);});
