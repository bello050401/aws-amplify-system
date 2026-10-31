import {test} from 'node:test';
import assert from 'node:assert/strict';
import iconv from 'iconv-lite';
import {EconveniHttpSession} from '../lib/listing/econveni/httpSession';
const html=(body:string)=>new Response(new Uint8Array(iconv.encode(body,'euc-jp')),{headers:{'content-type':'text/html; charset=euc-jp'}});
async function fixture(){
 let id='123',name='【在庫5】椅子',listing='h1234567890',wrongAction=false;
 const calls:{url:URL;init?:RequestInit}[]=[];
 const form=()=>`<form method="post" enctype="multipart/form-data" action="https://img.e-conveni.net/smart/functions.php"><input name="action" value="product_update"><input name="products_id" value="${id}"><input name="users_id" value="9350"><input name="products_name" value="${name}"><input name="products_quantity" value="5"><input name="base_stock" value="5"><input name="base_title" value="${name}"><input type="hidden" name="products_image_current" value="existing.jpg"><textarea name="bikou">KEEP NOTE</textarea></form>`;
 const transport:typeof fetch=async(input,init)=>{
  const u=new URL(String(input));calls.push({url:u,init});
  if(u.pathname==='/default.php')return html('<form method="post" action="https://member.e-conveni.net/login.php?action=process"><input name="users_account"><input name="users_passwd"></form>');
  if(u.pathname==='/login.php')return html('OK');
  if(u.pathname==='/product.php')return html(form().replace('</form>','<input type="file" name="products_image"></form>'));
  if(u.pathname==='/products.php')return html(`<form><select name="scop"><option>商品名</option></select></form>検索結果 : 1件<table><tr><td><input name="pidlist" value="123"></td><td>123</td><td><img src="https://img.e-conveni.net/smart/products/9350/123_1.jpg"></td><td><a href="product.php?action=product_update&products_id=123">${name}</a></td><td><a>出</a><a href="https://page.auctions.yahoo.co.jp/jp/auction/${listing}">ID</a><a href="functions.php?action=${wrongAction?'product_delete':'delete_aID'}&products_id=123&users_id=9350">消</a></td><td>外</td><td>外</td><td>外</td><td>外</td><td>外</td><td>5</td><td>10000</td></tr></table>`);
  if(u.pathname.endsWith('/functions.php'))return html('OK');
  throw Error('Unexpected endpoint '+u.pathname);
 };
 const session=new EconveniHttpSession(transport);await session.login({loginId:'fixture',password:'fixture'});calls.length=0;return {session,calls,edit:()=>{name='Changed';},wrong:()=>{id='other';},wrongListing:()=>{listing='h0000000000';},wrongAction:()=>{wrongAction=true;}};
}
test('sale edits preserve existing photos/notes and use observed form, not a destructive endpoint',async()=>{const f=await fixture();await f.session.updateSaleFields('123',{products_name:'【在庫5】椅子',products_quantity:'5'},{products_name:'【在庫3】椅子',products_quantity:'3'});const writes=f.calls.filter(c=>c.init?.method==='POST');assert.equal(writes.length,1);const body=iconv.decode(Buffer.from(writes[0].init!.body as any),'euc-jp');assert.match(body,/existing.jpg/);assert.match(body,/KEEP NOTE/);assert.match(body,/【在庫3】椅子/);await assert.rejects(f.session.updateSaleFields('123',{products_quantity:'5'},{products_quantity:'3'}));assert.equal(f.calls.filter(c=>c.init?.method==='POST').length,1);});
test('stale edit, unexpected product and unapproved fields do not POST',async()=>{for(const kind of ['edit','wrong','field']){const f=await fixture();if(kind==='edit')f.edit();if(kind==='wrong')f.wrong();await assert.rejects(f.session.updateSaleFields('123',{products_name:'【在庫5】椅子'},{[kind==='field'?'action':'products_name']:'x'}));assert.equal(f.calls.filter(c=>c.init?.method==='POST').length,0);}});
test('Yahoo clear calls only exact observed e-conveni ID unlink once; never Yahoo delete',async()=>{const f=await fixture();await f.session.clearSoldYahooId('123','h1234567890');const writes=f.calls.filter(c=>c.url.pathname==='/functions.php');assert.equal(writes.length,1);assert.equal(writes[0].url.origin,'https://smart.e-conveni.net');assert.equal(writes[0].url.searchParams.get('action'),'delete_aID');await assert.rejects(f.session.clearSoldYahooId('123','h1234567890'));assert.equal(f.calls.filter(c=>c.url.pathname==='/functions.php').length,1);});
test('wrong listing ID or deletion action never executes',async()=>{for(const kind of ['wrongListing','wrongAction'] as const){const f=await fixture();f[kind]();await assert.rejects(f.session.clearSoldYahooId('123','h1234567890'));assert.equal(f.calls.filter(c=>c.url.pathname==='/functions.php').length,0);}});
