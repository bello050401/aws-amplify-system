import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

test("cloud connection action rejects viewers before reading credentials and exposes only status", async () => {
  for (const role of [null,"VIEWER","EDITOR","ADMIN"]) {
    let secretReads=0,readCalls=0;
    const stubs={
      '@/lib/amplify/requireInventoryUser':{canEditInventory:r=>['ADMIN','EDITOR'].includes(r),getInventoryRole:async()=>role},
      '@/lib/listing/yahooAuction/webHttpRuntime':{readYahooRuntimeSession:async()=>{
        secretReads++; return {ok:true,session:{inspectInput:async()=>{readCalls++;return{ok:true,value:{notForClient:'private'}};}}};
      }},
    };
    const exports={};
    const code=ts.transpileModule(fs.readFileSync(new URL('../../../app/actions/yahooAuctionHttp.ts',import.meta.url),'utf8'),
      {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    vm.runInNewContext(code,{exports,require:name=>{if(!(name in stubs))throw Error(name);return stubs[name];}});
    const result=await exports.checkYahooHttpsConnectionAction();
    const allowed=['ADMIN','EDITOR'].includes(role);
    assert.equal(result.ok,allowed); assert.equal(secretReads,allowed?1:0); assert.equal(readCalls,allowed?1:0);
    assert.equal(JSON.stringify(result).includes('private'),false);
  }
});
