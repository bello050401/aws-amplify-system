import assert from "node:assert/strict";
import iconv from "iconv-lite";
import { EconveniHttpError, EconveniHttpSession, encodeForm, multipartForm, readForms } from "../lib/listing/econveni/httpSession";
const login='<table><form method="post" action="https://member.e-conveni.net/login.php?action=process"><tr><td><input name="users_account"><input type="password" name="users_passwd"><input name="server_name" type="hidden" value="smart"></td></tr></form></table>';
const product='<form method="post" enctype="multipart/form-data" action="https://img.e-conveni.net/smart/functions.php"><input type="hidden" name="action" value="product_add"><input name="products_name"><input type="file" name="products_image"><textarea name="bikou"></textarea><input type="checkbox" name="object" value="yes"><select name="category"><option value="chair">椅子</option></select></form>';
const html=(body:string,headers:Record<string,string>={})=>new Response(new Uint8Array(iconv.encode(body,"euc-jp")),{headers:{"content-type":"text/html; charset=euc-jp",...headers}});
const draft={products_name:"【BELLO検証・出品禁止】試験",bikou:"BELLO_TEST_ONLY\nBELLO_INVENTORY_ID=qa-econveni-test",object:"yes"};
const image={bytes:Buffer.from([0xff,0xd8,0,1,2,0xff,0xd9]),filename:"test.jpg",mimeType:"image/jpeg" as const};
async function main(){
 const fields=readForms({url:"https://smart.e-conveni.net/default.php",status:200,html:login})[0].fields;
 assert.deepEqual(fields.map(f=>f.name),["users_account","users_passwd","server_name"],"Legacy table controls must be preserved");
 assert.equal(encodeForm([["a","日本語 & +"]]),"a=%C6%FC%CB%DC%B8%EC+%26+%2B");
 assert.throws(()=>encodeForm([["title","emoji 😀"]]),EconveniHttpError);
 const multipart=multipartForm([["title","日本語\n二行目"]],[image]);
 assert.ok(multipart.body.includes(image.bytes));assert.ok(multipart.body.includes(iconv.encode("日本語\r\n二行目","euc-jp")));
 assert.throws(()=>multipartForm([], [{...image,filename:'a"\r\n.jpg'}]));
 const calls:{url:URL;init:RequestInit|undefined}[]=[];
 const transport:typeof fetch=async (input,init)=>{
  const url=new URL(String(input));calls.push({url,init});
  if(url.pathname==="/default.php")return html(login,{"set-cookie":"memberOnly=x; Domain=smart.e-conveni.net; Path=/; Secure"});
  if(url.hostname==="member.e-conveni.net"){
   assert.equal(new Headers(init?.headers).get("cookie"),null,"Host cookie must not cross origins");
   assert.ok(String(init?.body).includes("users_passwd=+secret+"));
   return new Response(null,{status:302,headers:{location:"https://smart.e-conveni.net/","set-cookie":"shared=y; Domain=.e-conveni.net; Path=/; Secure; HttpOnly"}});
  }
  if(url.hostname==="img.e-conveni.net"){
   assert.equal(new Headers(init?.headers).get("cookie"),"shared=y");
   throw new Error("timeout-private-response");
  }
  if(url.pathname==="/")return html("home");
  return html(product);
 };
 const session=new EconveniHttpSession(transport);await session.login({loginId:"user",password:" secret "});
 const before=calls.length;await session.registrationForm();await session.registrationForm();assert.equal(calls.length,before,"Reuse observed form");
 await assert.rejects(session.saveTestDraft({...draft,products_name:"real product"},[image]));
 assert.equal(calls.length,before);
 await assert.rejects(session.saveTestDraft(draft,[image]),e=>e instanceof EconveniHttpError&&e.code==="NETWORK"&&!e.message.includes("private"));
 await assert.rejects(session.saveTestDraft(draft,[image]));assert.equal(calls.filter(c=>c.url.hostname==="img.e-conveni.net").length,1,"Never resend an uncertain write");
 await assert.rejects(session.productPage("https://smart.e-conveni.net/product.php?action=delete&products_id=1"));
 for(const status of [401,403,429]){
  let count=0;const denied=new EconveniHttpSession(async()=>{count++;return new Response("private",{status});});
  await assert.rejects(denied.login({loginId:"u",password:"p"}),e=>e instanceof EconveniHttpError&&e.code==="ACCESS_DENIED");assert.equal(count,1);
 }
 const captcha=new EconveniHttpSession(async()=>html('<div class="g-recaptcha"></div>'));
 await assert.rejects(captcha.login({loginId:"u",password:"p"}),e=>e instanceof EconveniHttpError&&e.code==="ADDITIONAL_AUTH");
 let externalCalls=0;const external=new EconveniHttpSession(async()=>{externalCalls++;return new Response(null,{status:302,headers:{location:"https://unexpected.invalid"}});});
 await assert.rejects(external.login({loginId:"u",password:"p"}),e=>e instanceof EconveniHttpError&&e.code==="UNSAFE_DESTINATION");assert.equal(externalCalls,1);
 let redirectCalls=0;const replay=new EconveniHttpSession(async()=>{redirectCalls++;return redirectCalls===1?html(login):new Response(null,{status:307,headers:{location:"https://smart.e-conveni.net/"}});});
 await assert.rejects(replay.login({loginId:"u",password:"p"}),e=>e instanceof EconveniHttpError&&e.code==="CONTRACT_CHANGED");assert.equal(redirectCalls,2);
 const wrongAction=new EconveniHttpSession(async(input)=>String(input).includes("default.php")?html(login):html(product.replace('value="product_add"','value="product_delete"')));
 await wrongAction.login({loginId:"u",password:"p"});await assert.rejects(wrongAction.saveTestDraft(draft,[image]));
 console.log("PASS: legacy form parsing, EUC-JP integrity, binary images, cookie scope, form cache, save-only contract, timeout no-retry, access denial stop, CAPTCHA stop, redirect restrictions");
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
