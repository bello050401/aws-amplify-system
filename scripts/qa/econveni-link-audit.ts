import {writeFileSync,mkdirSync} from 'node:fs';
import {ScanCommand} from '@aws-sdk/lib-dynamodb';
import {refreshManualSync,readManualSync} from '../../lib/listing/econveni/manualSync';
import {readEconveniCatalog,econveniDatabase as db} from '../../lib/listing/econveni/runtimeStore';
import {titleSimilarity} from '../../lib/listing/econveni/manualSyncModel';
async function main(){
 const data=process.argv.includes('--refresh')?await refreshManualSync():await readManualSync();
 const flows=await readEconveniCatalog();
 const suffix=process.env.CONVERSATION_TABLE_NAME?.replace(/^Conversation-/,'');if(!suffix)throw Error('NO_TABLE');
 const rows:any[]=[];let key:any;
 do{const r=await db.send(new ScanCommand({TableName:'Inventory-'+suffix,ExclusiveStartKey:key,ProjectionExpression:'id,displayId,#n,quantity,categoryIds,categoryId,images,updatedAt,saleEndDate,market,zaicoItemId,listingPartition,isDeleted,deletedAt',ExpressionAttributeNames:{'#n':'name'}}));rows.push(...r.Items??[]);key=r.LastEvaluatedKey;}while(key);
 const cats=await db.send(new ScanCommand({TableName:'Category-'+suffix,ProjectionExpression:'id,#n',ExpressionAttributeNames:{'#n':'name'}}));const names=new Map(cats.Items?.map(x=>[x.id,x.name]));
 const stocks=rows.filter(x=>!x.isDeleted&&!x.deletedAt&&x.listingPartition!=='MERGED').map(x=>({...x,categories:(x.categoryIds?.length?x.categoryIds:[x.categoryId]).map((id:string)=>names.get(id)).filter(Boolean)}));
 const linked=new Set([...data.links.map(l=>l.productId),...flows.map(w=>w.save.productId).filter(Boolean)]);
 const unlinked=(data.snapshot?.products??[]).filter(p=>!linked.has(p.productId)).map(product=>({product,candidates:stocks.map(item=>({item,score:titleSimilarity(product.title,item.name??'')})).sort((a,b)=>b.score-a.score).slice(0,6)}));
 const path='artifacts/econveni-parity-20261112';mkdirSync(path,{recursive:true});writeFileSync(path+'/link-audit.json',JSON.stringify({data,flows,unlinked,stocks},null,2));
 console.log(JSON.stringify({total:data.snapshot?.products.length,checkedAt:data.snapshot?.checkedAt,linked:(data.snapshot?.products.length??0)-unlinked.length,unlinked:unlinked.map(r=>({productId:r.product.productId,title:r.product.title,candidates:r.candidates.slice(0,3).map(c=>({id:c.item.id,displayId:c.item.displayId,name:c.item.name,qty:c.item.quantity,categories:c.item.categories,score:c.score}))}))},null,2));
}main().catch(e=>{console.error(e.name,e.code??e.message);process.exitCode=1;});
