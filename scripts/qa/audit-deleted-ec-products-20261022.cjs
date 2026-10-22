const {DynamoDBClient}=require('@aws-sdk/client-dynamodb');
const {DynamoDBDocumentClient,GetCommand,ScanCommand}=require('@aws-sdk/lib-dynamodb');
const fs=require('node:fs');
const path=require('node:path');
async function main(){
 const output=process.argv[2]; if(!output)throw Error('Output directory required');
 const db=DynamoDBDocumentClient.from(new DynamoDBClient({region:'us-west-2'}));
 const suffix='-j6up24p7lnczdmklzjdt3vrp4y-NONE';
 const ids=['f1026ce3-3e4e-4b40-8d12-42416c378962','ec0f6fd3-6991-4f08-bf47-18b63e6ec97b','1c3c562d-179f-4a55-be41-78e183989c84'];
 const inventory=await Promise.all(ids.map(async id=>{
  const r=(await db.send(new GetCommand({TableName:'Inventory'+suffix,Key:{id},ConsistentRead:true,
   ProjectionExpression:'id,sku,#n,deletedAt,deletedBy,listingPartition,sourceSystem,sourceInventoryId,updatedAt',ExpressionAttributeNames:{'#n':'name'}}))).Item;
  return r??{id,absent:true};
 }));
 const drafts=[]; let cursor;
 do{const page=await db.send(new ScanCommand({TableName:'ListingDraft'+suffix,ConsistentRead:true,ExclusiveStartKey:cursor,
  FilterExpression:'inventoryId IN (:a,:b,:c)',ExpressionAttributeValues:{':a':ids[0],':b':ids[1],':c':ids[2]},ProjectionExpression:'id,inventoryId,deletedAt,updatedAt'}));
  drafts.push(...page.Items??[]);cursor=page.LastEvaluatedKey;
 }while(cursor);
 const result={at:new Date().toISOString(),inventory,drafts,readOnly:true};
 fs.mkdirSync(output,{recursive:true}); fs.writeFileSync(path.join(output,'削除済み3商品_AWS現状.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify(result,null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
