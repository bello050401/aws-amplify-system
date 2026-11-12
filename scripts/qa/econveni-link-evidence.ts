import {readFileSync,writeFileSync} from 'node:fs';
import {ScanCommand,BatchGetCommand} from '@aws-sdk/lib-dynamodb';
import {econveniDatabase as db} from '../../lib/listing/econveni/runtimeStore';
async function main(){
 const dir='artifacts/econveni-parity-20261112',audit=JSON.parse(readFileSync(dir+'/link-audit.json','utf8')),outputs=JSON.parse(readFileSync('../bello-pc-mobile-parity-20261110/amplify_outputs.json','utf8'));
 const wanted=[0,4,11,18,23,25,27,28].map(i=>audit.unlinked[i]);const ids=new Set(wanted.flatMap(r=>Object.values(r.product.channels).map((s:any)=>s.listingId).filter(Boolean)));
 const tables:{table:string;projection:string;names:Record<string,string>}[]=[{table:outputs.custom.saleCandidates.tableName,projection:'pk,#c,externalListingId,orderId,#r,#s,linkedInventoryId,updatedAt',names:{'#c':'channel','#r':'result','#s':'state'}},{table:'ChannelListing-j6up24p7lnczdmklzjdt3vrp4y-NONE',projection:'id,inventoryId,externalListingId,listingUrl,#s,#c',names:{'#s':'status','#c':'channel'}}];
 const evidence:any[]=[];
 for(const t of tables){let key:any;do{const r=await db.send(new ScanCommand({TableName:t.table,ExclusiveStartKey:key,ProjectionExpression:t.projection,ExpressionAttributeNames:t.names}));evidence.push(...(r.Items??[]).filter(x=>ids.has(x.externalListingId)||ids.has(x.orderId)));key=r.LastEvaluatedKey;}while(key);}
 const candidateIds=[...new Set(wanted.flatMap(r=>r.candidates.map((c:any)=>c.item.id)))];const items=await db.send(new BatchGetCommand({RequestItems:{'Inventory-j6up24p7lnczdmklzjdt3vrp4y-NONE':{Keys:candidateIds.map(id=>({id})),ProjectionExpression:'id,createdAt,updatedAt,splitFromInventoryId,parentInventoryId,sourceInventoryId,customFields,baseItemId,externalProductId,sku,market,quantity,saleEndDate'}}}));
 writeFileSync(dir+'/link-evidence.json',JSON.stringify({evidence,items:items.Responses},null,2));
 const stocks=items.Responses?.['Inventory-j6up24p7lnczdmklzjdt3vrp4y-NONE']??[];
 console.log(JSON.stringify(wanted.map(r=>({remote:r.product.productId,channels:r.product.channels,candidates:r.candidates.map((c:any)=>{const x=stocks.find(s=>s.id===c.item.id);return {id:c.item.id,name:c.item.name,qty:x?.quantity,externalId:x?.externalProductId,baseId:x?.baseItemId,market:x?.market,sold:x?.saleEndDate,created:x?.createdAt,split:x?.splitFromInventoryId};})})),null,2));
}main().catch(e=>{console.error(e.name);process.exitCode=1});
