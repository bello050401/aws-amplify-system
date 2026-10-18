import assert from "node:assert/strict";
import { createListingWorkflow, type Client, type Remote, type Source } from "../lib/listing/independentShop/workflow";
import { createIndependentShopClient } from "../lib/listing/independentShop/client";

async function main(){
 let role:string|null="EDITOR", sourceUnavailable=false, saves=0, writes:Record<string,unknown>[]=[];
 const source:Source={id:"test",name:"Chair",sku:"B1",price:92000,description:"Chair description",quantity:1,version:"v1",images:[{storageKey:"inventory/test.jpg",sortOrder:0}]};
 let remote:Remote={id:"remote-test",revision:1,stock:1,status:"draft",name:"Chair",price:92000,images:["/media/test.jpg"]};
 const api:Client={find:async()=>({...remote}),upload:async()=>{throw Error("Unexpected upload")},save:async item=>{saves++;writes.push(item);assert.equal(item.externalId,"inventory:test");assert.equal(item.revision,remote.revision);remote={...remote,status:String(item.status),revision:remote.revision+1};return {id:remote.id,revision:remote.revision}}};
 const flow=createListingWorkflow({role:async()=>role,source:async()=>{if(sourceUnavailable)throw Error("Deleted inventory");return source},client:async()=>({api,signingKey:"test-secret"}),image:async()=>{throw Error("Unexpected image read")}});
 role="VIEWER";await assert.rejects(()=>flow.publicationPreview("test"),/ログイン/);assert.equal(saves,0);role="EDITOR";
 const p=await flow.publicationPreview("test");assert.equal(p.target,"published");assert.equal(saves,0);
 await assert.rejects(()=>flow.changePublication("other",p.token!),/商品ID/);
 await assert.rejects(()=>flow.changePublication("test",p.token!+"x"),/確認/);assert.equal(saves,0);
 remote={...remote,revision:2};await assert.rejects(()=>flow.changePublication("test",p.token!),/更新/);
 const ready=await flow.publicationPreview("test");assert.deepEqual(await flow.changePublication("test",ready.token!),{id:"remote-test",status:"published"});
 assert.deepEqual(Object.keys(writes[0]).sort(),["externalId","revision","status"]);
 await assert.rejects(()=>flow.changePublication("test",ready.token!),/更新/);assert.equal(saves,1);
 // Removing common data after publication must not prevent taking an item offline.
 sourceUnavailable=true;const stop=await flow.publicationPreview("test");assert.equal(stop.target,"draft");await flow.changePublication("test",stop.token!);assert.equal(remote.status,"draft");assert.equal(saves,2);
 sourceUnavailable=false;remote={...remote,stock:0};await assert.rejects(()=>flow.publicationPreview("test"),/販売可能数/);
 remote={...remote,stock:2};await assert.rejects(()=>flow.publicationPreview("test"),/現在庫/);
 remote={...remote,stock:1};const unconfirmed=createListingWorkflow({role:async()=>role,source:async()=>source,client:async()=>({api:{...api,save:async()=>({id:remote.id,revision:remote.revision})},signingKey:"key"}),image:async()=>new Blob()});
 const unconfirmedPreview=await unconfirmed.publicationPreview("test");await assert.rejects(()=>unconfirmed.changePublication("test",unconfirmedPreview.token!),/出品状態を確認できません/);
 for(const items of [[{...remote,externalId:"inventory:wrong"}],[{...remote,externalId:"inventory:test"},{...remote,externalId:"inventory:test"}]]){
  const client=createIndependentShopClient({apiKey:"test",sitesServiceToken:"test"},async()=>Response.json({items}));await assert.rejects(()=>client.find("inventory:test"),/一致|照合/);
 }
 const client=createIndependentShopClient({apiKey:"test",sitesServiceToken:"test"},async()=>Response.json({items:[{...remote,externalId:"inventory:test"}]}));assert.equal((await client.find("inventory:test"))?.price,92000);
 console.log("PASS: publication, stop after inventory loss, role/token/revision guards, zero/excess stock, readback, channel identity and public-field isolation");
}
main().catch(e=>{console.error(e);process.exitCode=1});
