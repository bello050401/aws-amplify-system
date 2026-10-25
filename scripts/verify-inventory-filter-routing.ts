import assert from 'node:assert/strict';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,ScanCommand,type ScanCommandOutput} from '@aws-sdk/lib-dynamodb';
import {searchInventoryFast} from '../lib/inventory/inventorySearchFast';
import {compareInventoryDateDesc} from '../lib/inventory/productDates';
import {inventoryCategoryIds,type CategoryRecord} from '../lib/inventory/categories';
import {ensureConversationTableName} from './lib/resolveStagingTables';
import {directTableName} from '../lib/amplify/directData';
type RawInventory = Record<string,any> & CategoryRecord & {id:string;updatedAt:string};

async function main(){
 await ensureConversationTableName();const TableName=directTableName('Inventory');
 const db=DynamoDBDocumentClient.from(new DynamoDBClient({region:'us-west-2'}));
 const segments=await Promise.all(Array.from({length:8},async(_,Segment)=>{
  const rows:RawInventory[]=[];let key:ScanCommandOutput['LastEvaluatedKey'];
  do{const r:ScanCommandOutput=await db.send(new ScanCommand({TableName,Segment,TotalSegments:8,ExclusiveStartKey:key,FilterExpression:'attribute_not_exists(deletedAt) AND (attribute_not_exists(listingPartition) OR listingPartition <> :merged)',ExpressionAttributeValues:{':merged':'MERGED'}}));rows.push(...(r.Items??[]) as RawInventory[]);key=r.LastEvaluatedKey;}while(key);
  return rows;
 }));
 const all=segments.flat().sort(compareInventoryDateDesc);
 const category='d31dac43-8bd7-4299-9348-2df204d24229';
 const other='beed41c6-7678-4846-a928-32393e7c7477';
 const location='4ccd1da5-59c3-414e-b6df-a35d3ff6164d';
 const cases=[{categoryIds:[category]},{categoryIds:[category,other]},{locationId:location},{categoryIds:[category],locationId:location},{categoryIds:['not-existing-filter']},{locationId:location}];
 for(const [i,filters] of cases.entries()){
  const offset=i===5?50:0;
  const expected=all.filter(r=>(!filters.categoryIds||filters.categoryIds.some(id=>inventoryCategoryIds(r).includes(id)))&&(!filters.locationId||r.locationId===filters.locationId));
  const t=Date.now();const actual=await searchInventoryFast({filters},{offset,limit:50});assert.ok(actual);
  assert.equal(actual.total,expected.length);
  assert.deepEqual(actual.rawItems.map(r=>r.id),expected.slice(offset,offset+50).map(r=>r.id));
  assert.deepEqual(actual.rawItems,expected.slice(offset,offset+50));
  console.log(JSON.stringify({case:i+1,total:actual.total,offset,rows:actual.rawItems.length,ms:Date.now()-t,pass:true}));
 }
 console.log(`6 filter cases passed against ${all.length} live records: counts, order and full row contents match.`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
