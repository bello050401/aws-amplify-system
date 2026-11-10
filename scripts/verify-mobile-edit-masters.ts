import assert from 'node:assert/strict';
import {build} from 'esbuild';
import vm from 'node:vm';

async function main() {
  let allowed = true, failing = false, reads = 0, fallbacks = 0;
  const ports = {
    auth: async () => allowed,
    fallback: async () => {fallbacks++; return [];},
    scan: async (input: Record<string, any>) => {
      reads++;
      assert.equal(input.ConsistentRead, true);
      assert.equal(input.FilterExpression, '#active = :active');
      assert.equal(JSON.stringify(input.ExpressionAttributeValues), JSON.stringify({':active':true}));
      assert.equal(input.ProjectionExpression.includes('secret'), false);
      if (failing) throw Error('IAM unavailable');
      if (input.TableName === 'CustomFieldDefinition') return {Items:[{id:'custom',fieldKey:'size',label:'寸法',fieldType:'TEXT',required:false,sortOrder:0,options:[],isActive:true}]};
      if (input.TableName === 'StatusMaster') return {Items:[{id:'status',code:'OK',label:'正常'}]};
      return input.ExclusiveStartKey
        ? {Items:[{id:'a',name:'ア',sortOrder:1}]}
        : {Items:[{id:'b',name:'イ',sortOrder:2}],LastEvaluatedKey:{id:'cursor'}};
    },
  };
  const stubs: Record<string,string> = {
    'server-only':'',
    '@aws-sdk/client-dynamodb':'export class DynamoDBClient {}',
    '@aws-sdk/lib-dynamodb':'export class ScanCommand {constructor(input){this.input=input;}}; export const DynamoDBDocumentClient={from:()=>({send:cmd=>globalThis.ports.scan(cmd.input)})};',
    '../amplify/directData':'export const directTableName=name=>name;',
    '../inventory/mutationSession':'export const inventoryVerifiedReadSession=()=>globalThis.ports.auth();',
    '../inventory/queries':'export const listCategories=()=>globalThis.ports.fallback();export const listLocations=listCategories;export const listStatuses=listCategories; export const listCustomFieldDefinitions=listCategories; export const toCustomFieldDefinitionRow=r=>r;',
  };
  const bundle = await build({stdin:{contents:"export * from './lib/mobile/editMasters'; export * from './lib/inventory/masterCache';",resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,platform:'node',format:'cjs',plugins:[{name:'ports',setup(b){
    b.onResolve({filter:/.*/},args=>Object.hasOwn(stubs,args.path)?{path:args.path,namespace:'port'}:undefined);
    b.onLoad({filter:/.*/,namespace:'port'},args=>({contents:stubs[args.path],loader:'js'}));
  }}]});
  const module = {exports:{} as any};
  // Share the same JSON realm for the synthetic transport assertions.
  vm.runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,ports,Date,Map,Promise,Error,process:{env:{}}});
  const api = module.exports;
  const categories = await api.listMobileEditCategories();
  assert.equal(JSON.stringify(categories),JSON.stringify([{id:'a',name:'ア',parentId:null,sortOrder:1},{id:'b',name:'イ',parentId:null,sortOrder:2}]));
  assert.equal(reads,2);assert.equal(fallbacks,0);
  categories.pop(); assert.equal((await api.listMobileEditCategories()).length,2);assert.equal(reads,2);
  allowed=false;assert.equal((await api.listMobileEditCategories()).length,0);assert.equal(reads,2);assert.equal(fallbacks,1);
  allowed=true;await api.listMobileEditLocations();assert.equal(reads,4);
  const statuses=await api.listMobileEditStatuses();assert.equal(statuses[0].code,'OK');assert.equal(reads,5);
  api.invalidateMasterCache();await api.listMobileEditCategories();assert.equal(reads,7);
  api.invalidateMasterCache();failing=true;await api.listMobileEditCategories();assert.equal(fallbacks,2);
  failing=false;await api.listMobileEditCategories();assert.equal(reads,10,'Failed reads are not cached');
  const custom=await api.listFastCustomFieldDefinitions();assert.equal(custom[0].fieldKey,'size');
  const readsBefore=reads;await api.listFastCustomFieldDefinitions();assert.equal(reads,readsBefore);
  allowed=false;assert.equal((await api.listFastCustomFieldDefinitions()).length,0);assert.equal(reads,readsBefore);
  console.log('PASS: master paging, projection, order, cache invalidation, signed-session gate and IAM fallback');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
