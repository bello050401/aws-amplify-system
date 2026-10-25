import { fromIni } from "@aws-sdk/credential-providers";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { readFile, writeFile, access } from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EconveniCredentialStore } from "../../lib/listing/econveni/credentials";
import { EconveniHttpSession, readForms, EconveniHttpError } from "../../lib/listing/econveni/httpSession";
const receipt="artifacts/econveni-20261025/http-save-receipt.json";
const values={
 products_name:"【BELLO検証・出品禁止】HTTP保存 20261025-02",products_description:"<p>日本語・英数字／保存専用の検証です。<br>実際には販売しません。</p>",
 products_quantity:"2",products_price:"12346",products_willprice:"12346",products_category:"2084057261",yahoo_setting_id:"22024",yahoo_information_id:"8297",
 mercariShops_name:"【BELLO検証・出品禁止】HTTP保存 20261025-02",mercariShops_description:"日本語・英数字／保存専用の検証です。\n実際には販売しません。",
 mercariShops_categoryId:"uCmnfJGdXF7HAhN2A9Ab7L",mercariShops_brandId:"",mercariShops_variants:":2:BELLO-QA-20261025-02:",mercariShops_condition:"CONDITION_LITTLE_DIRTY",mercariShops_price:"12346",mercariShops_setting_id:"133",
 bikou:"BELLO_TEST_ONLY\nBELLO_INVENTORY_ID=qa-econveni-20261025-02\nBELLO_OPERATION_ID=http-save-20261025-02\n出品禁止・保存確認専用",object:"yes",
};
async function main(){
 try {await access(receipt);throw new Error("ALREADY_ATTEMPTED_RECONCILE_ONLY");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
 const store=new EconveniCredentialStore(new SecretsManagerClient({region:"us-west-2",credentials:fromIni({profile:"Bello"})}));
 const credentials=await store.credentials(); if(!credentials)throw new Error("NOT_CONFIGURED");
 const session=new EconveniHttpSession(); await session.login(credentials);
 const images=await Promise.all([1,2].map(async i=>({bytes:await readFile(`artifacts/econveni-20261025/fixtures/test-${i}.jpg`),mimeType:"image/jpeg" as const,filename:`test-${i}.jpg`})));
 const attemptedAt=new Date().toISOString();
 // Durable test journal before the external POST. This file MUST NOT be removed to retry.
 await writeFile(receipt,JSON.stringify({stage:"VERIFY_REQUIRED",attemptedAt,operationId:"http-save-20261025-02"},null,2),{flag:"wx"});
 const response=await session.saveTestDraft(values,images);
 const url=new URL(response.url),remoteId=url.searchParams.get("products_id");
 assert.match(remoteId??"",/^\d+$/); assert.equal(url.searchParams.get("action"),"product_update");
 await writeFile(receipt,JSON.stringify({stage:"VERIFY_REQUIRED",attemptedAt,remoteId,url:url.href},null,2));
 const page=await session.productPage(url.href);
 const form=readForms(page).find(f=>f.fields.some(x=>x.name==="products_name"));assert.ok(form);
 const mismatches=Object.entries(values).filter(([name,value])=>name!=="object"&&form.fields.find(f=>f.name===name)?.value.replace(/\r\n/g,"\n")!==value).map(([name])=>name);
 const excluded=form.fields.find(f=>f.name==="object")?.checked===true;
 const imageChecks=[];
 for(let i=1;i<=2;i++){
  const match=page.html.match(new RegExp('https://img\\.e-conveni\\.net/smart/products/([0-9]+)/'+remoteId+'_'+i+'\\.jpg'));
  assert.ok(match);const r=await fetch(match[0]);assert.equal(r.status,200);const remote=Buffer.from(await r.arrayBuffer());
  const hash=(b:Buffer)=>createHash("sha256").update(b).digest("hex");imageChecks.push({index:i,byteIdentical:hash(remote)===hash(images[i-1].bytes),bytes:remote.length});
 }
 const result={stage:mismatches.length?"VERIFY_REQUIRED":"SAVED",attemptedAt,remoteId,url:url.href,mismatches,excluded,imageChecks,published:false};
 await writeFile(receipt,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 assert.deepEqual(mismatches,[]);
}
void main().catch(e=>{console.error(e instanceof EconveniHttpError?e.code:e instanceof assert.AssertionError?"SAVE_VERIFICATION_FAILED":e.message==="ALREADY_ATTEMPTED_RECONCILE_ONLY"?e.message:"SAVE_RESULT_UNCERTAIN");process.exitCode=1;});
