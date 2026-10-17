/** Read-only: compare full-set expectations with the production search engine and pagination. */
import assert from "node:assert/strict";
import {DynamoDBClient} from "@aws-sdk/client-dynamodb";
import {DynamoDBDocumentClient,ScanCommand} from "@aws-sdk/lib-dynamodb";
import {ensureConversationTableName} from "./lib/resolveStagingTables";
import {STATIC_SEARCH_FIELDS,evaluateQuery,type AdvancedSearchQuery} from "../lib/inventory/advancedSearch";
import {searchInventoryFast} from "../lib/inventory/inventorySearchFast";

async function main() {
  const region="us-west-2";
  const conversation=await ensureConversationTableName(region);
  const table=conversation.replace(/^Conversation-/,"Inventory-");
  const client=DynamoDBDocumentClient.from(new DynamoDBClient({region}));
  let key:Record<string,unknown>|undefined;
  const rows:Record<string,unknown>[]=[];
  do {
    const page=await client.send(new ScanCommand({TableName:table,ExclusiveStartKey:key,
      FilterExpression:"attribute_not_exists(#deleted)",ProjectionExpression:"#id,#quantity,#category,#price",
      ExpressionAttributeNames:{"#deleted":"deletedAt","#id":"id","#quantity":"quantity","#category":"categoryId","#price":"plannedSalePrice"}}));
    rows.push(...(page.Items ?? []));key=page.LastEvaluatedKey;
  } while(key);
  const fieldsByKey=new Map(STATIC_SEARCH_FIELDS.map(field=>[field.key,field]));
  const counts=new Map<string,number>();
  for(const row of rows) if(row.categoryId) counts.set(String(row.categoryId),(counts.get(String(row.categoryId))??0)+1);
  const category=[...counts.entries()].sort((a,b)=>b[1]-a[1])[0][0];
  const conditions:AdvancedSearchQuery["conditions"]=[{id:"1",field:"quantity",operator:"ge",value:"0"},{id:"2",field:"plannedSalePrice",operator:"between",value:"10000",value2:"50000"}];
  for(const combinator of ["AND","OR"] as const) {
    const query={combinator,conditions};
    const expected=rows.filter(row=>row.categoryId===category&&evaluateQuery({...row,quantity:row.quantity??0,customFields:null},query,fieldsByKey));
    assert.ok(expected.length>50,"Exercise multiple populated pages");
    for(const direction of ["asc","desc"] as const) {
      expected.sort((a,b)=>(Number(a.quantity??0)-Number(b.quantity??0))*(direction==="asc"?1:-1)||String(b.id).localeCompare(String(a.id),"ja",{numeric:true,sensitivity:"base"}));
      for(const offset of [0,50]) {
        const started=Date.now();
        const page=await searchInventoryFast({filters:{categoryIds:[category]},advanced:{query,fieldsByKey},sort:{field:"quantity",direction},fieldsByKey},{offset,limit:50});
        assert.ok(page,"Fast search must be available");assert.equal(page.total,expected.length);
        assert.deepEqual(page.rawItems.map(row=>row.id),expected.slice(offset,offset+50).map(row=>row.id));
        assert.equal(page.totalQuantity,expected.reduce((sum,row)=>sum+Number(row.quantity??0),0));
        console.log(JSON.stringify({combinator,direction,offset,scanned:rows.length,matches:page.total,page:page.rawItems.length,ms:Date.now()-started,verified:true}));
      }
    }
  }
}
main().catch(error=>{console.error(error instanceof Error?error.name:"Verification failed");process.exitCode=1;});
