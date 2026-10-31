import assert from 'node:assert/strict';
import {readCompactSearch} from '../lib/inventory/readCompactSearch';
import {COMPACT_SEARCH_FIELDS,COMPACT_SEARCH_INDEX,supportsCompactSearch} from '../lib/inventory/compactSearchIndex';
import {DetailReadAhead} from '../mobile/src/domain/detailReadAhead';
import type {InventoryItem} from '../mobile/src/domain/inventory';

async function main(){
  assert.equal(COMPACT_SEARCH_FIELDS.length,20);
  for(const forbidden of ['images','customFields','note','sellerAddress','adminMemo']) assert(!supportsCompactSearch([forbidden]));
  assert(supportsCompactSearch(['name','barcode','quantity','categoryIds','updatedAt']));
  let calls:any[]=[];
  const client={send:async(command:any)=>{calls.push(command.input);return {Items:[{id:String(command.input.Segment)}]};}} as any;
  process.env.BELLO_COMPACT_SEARCH_INDEX='0';
  assert.equal(await readCompactSearch(client,{TableName:'Inventory'},['name']),null);assert.equal(calls.length,0);
  process.env.BELLO_COMPACT_SEARCH_INDEX='1';
  assert.equal(await readCompactSearch(client,{TableName:'Inventory'},['customFields']),null);assert.equal(calls.length,0);
  const result=await readCompactSearch(client,{TableName:'Inventory',ProjectionExpression:'#n',ExpressionAttributeNames:{'#n':'name'},FilterExpression:'attribute_not_exists(deletedAt)'},['name','deletedAt']);
  assert.equal(result!.length,4);assert.equal(calls.length,4);assert(calls.every(c=>c.IndexName===COMPACT_SEARCH_INDEX&&c.TotalSegments===4&&c.FilterExpression==='attribute_not_exists(deletedAt)'));
  calls=[];
  const paging={send:async(command:any)=>{calls.push(command.input);return command.input.ExclusiveStartKey?{Items:[{id:'last'}]}:{Items:[{id:'first'}],LastEvaluatedKey:{id:'first'}};}} as any;
  assert.equal((await readCompactSearch(paging,{TableName:'Inventory'},['id']))!.length,8);assert.equal(calls.length,8);
  for (const name of ['ResourceNotFoundException','AccessDeniedException','ProvisionedThroughputExceededException']) {
    assert.equal(await readCompactSearch({send:async()=>{throw Object.assign(Error('failed'),{name});}} as any,{TableName:'Inventory'},['id']),null);
  }
  assert.equal(await readCompactSearch({send:async()=>({Items:[],LastEvaluatedKey:{id:'loop'}})} as any,{TableName:'Inventory'},['id']),null);
  console.log('PASS compact index: supported fields, feature switch, pagination, partial/error fallback, bounds');

  let now=0,reads=0;
  const item=(id:string):InventoryItem=>({id,name:'sample',sku:'B1',quantity:5,unit:'点',location:'所沢',category:'補修待ち',condition:'',note:'',barcode:'',plannedSalePrice:null,thumbnailUrl:null,updatedAt:'v1'});
  const ahead=new DetailReadAhead(async id=>{reads++;return item(id);},()=>now);
  ahead.prepare('a','v1');ahead.prepare('a','v1');
  assert.equal((await ahead.read('a','v1')).id,'a');assert.equal(reads,1);
  await ahead.read('a','v1');assert.equal(reads,2,'consumed only once');
  ahead.prepare('b','v1');await Promise.resolve();await ahead.read('b','v2');assert.equal(reads,4,'list version changes must refetch');
  ahead.prepare('c','v1');await Promise.resolve();now=6000;await ahead.read('c','v1');assert.equal(reads,6,'expiry must refetch');
  ahead.prepare('d','v1');ahead.clear();await ahead.read('d','v1');assert.equal(reads,8,'writes/revocation clear');
  let release!:(value:InventoryItem)=>void,blockedCalls=0;
  const blocked=new DetailReadAhead(id=>{blockedCalls++;return new Promise(resolve=>{release=resolve;});},()=>0);
  blocked.prepare('a','v1');blocked.prepare('b','v1');blocked.prepare('c','v1');assert.equal(blockedCalls,2,'at most two speculative requests');
  blocked.clear();release(item('b'));
  let errors=0;const broken=new DetailReadAhead(async()=>{errors++;throw Error('denied');});
  broken.prepare('a','v1');await assert.rejects(broken.read('a','v1'));await assert.rejects(broken.read('a','v1'));assert.equal(errors,2,'no failed response reuse');
  const otherAccount=new DetailReadAhead(async id=>({...item(id),name:'other account'}));
  assert.equal((await otherAccount.read('a','v1')).name,'other account');
  console.log('PASS detail read-ahead: one-use, version, TTL, writes/logout, concurrency, failures, account isolation');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
