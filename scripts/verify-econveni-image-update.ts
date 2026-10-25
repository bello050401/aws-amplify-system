import assert from 'node:assert/strict';
import {EconveniHttpSession,readForms,type HtmlPage} from '../lib/listing/econveni/httpSession';
const id='owned-inventory',op='owned-operation';
const binding={productId:'123',operationId:op,url:'https://smart.e-conveni.net/product.php?action=product_update&products_id=123'};
const form='<form method="post" enctype="multipart/form-data" action="https://img.e-conveni.net/smart/functions.php"><input type="hidden" name="action" value="product_update"><input type="hidden" name="users_id" value="9350"><input type="hidden" name="products_id" value="123"><input name="products_name" value="Test"><textarea name="bikou">BELLO_INVENTORY_ID=owned-inventory</textarea></form>';
async function check(wrong=false,withImages=true){
 const calls:string[]=[];
 const s=new EconveniHttpSession(async(input)=>{calls.push(String(input));return new Response('ok',{headers:{'content-type':'text/html;charset=utf-8'}})});
 s.findInventory=async()=>[binding];
 s.readInventory=async()=>({...binding,channels:{YAHOO:{state:'INACTIVE',listingId:null,listingUrl:null},MERCARI_SHOPS:{state:'INACTIVE',listingId:null,listingUrl:null}}});
 s.productPage=async()=>({url:binding.url,status:200,html:form+`<input value="画像2を削除" onclick="location.href='https://img.e-conveni.net/smart/functions.php?action=delete_image2&amp;users_id=9350&amp;products_id=${wrong?'999':'123'}&amp;products_image2=123_2.jpg'">`});
 const image={bytes:Buffer.from('owned-image'),filename:'photo.jpg',mimeType:'image/jpeg' as const};
 const run=()=>s.saveProduct(id,op,{products_name:'Test'},withImages?[image]:[],binding);
 if(wrong)await assert.rejects(run);else await run();
 const deletes=calls.filter(c=>c.includes('delete_image'));
 assert.equal(deletes.length,withImages&&!wrong?1:0);
 if(deletes.length)assert.equal(new URL(deletes[0]).searchParams.get('products_id'),'123');
}
async function main(){await check();await check(true);await check(false,false);console.log('PASS: shorter image selection removes only exact owned trailing image; foreign product deletion blocked; metadata-only update retains images');}
void main().catch(e=>{console.error(e);process.exitCode=1});
