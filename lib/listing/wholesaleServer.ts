import 'server-only';
import {BatchGetCommand} from '@aws-sdk/lib-dynamodb';
import {inventoryDdb,inventoryTable,getInventoryRaw,persistInventoryWithCategories,type InventoryTransaction} from '@/lib/inventory/categoryPersistence';
import {inventoryCategoryIds} from '@/lib/inventory/categories';
import {listAllMasterEntries} from '@/lib/inventory/masters';
import {InventorySaveError} from '@/lib/inventory/conditionalUpdate';
import {readManualSync} from './econveni/manualSync';
import {readEconveniCatalog,ECONVENI_WORKFLOW_TABLE} from './econveni/runtimeStore';
import {manualLinkKey} from './econveni/manualSyncModel';
import {activeWholesaleBindings,wholesaleRow} from './wholesaleModel';
import type {WholesaleData,WholesaleSaveRequest,WholesaleSaveResult} from './wholesale';
import type {InventoryRole} from '@/lib/amplify/requireInventoryUser';

const editable=(role:InventoryRole)=>role==='ADMIN'||role==='EDITOR';
async function context(){
 const [manual,flows,categories]=await Promise.all([readManualSync(),readEconveniCatalog(),listAllMasterEntries('Category')]);
 const wholesale=categories.filter(c=>c.isActive&&c.name.normalize('NFKC').trim()==='業者間');
 if(wholesale.length>1)throw Error('業者間カテゴリーが重複しています。設定を確認してください。');
 return {manual,flows,wholesaleId:wholesale[0]?.id,...activeWholesaleBindings(manual,flows)};
}
export async function loadWholesale(role:InventoryRole):Promise<WholesaleData>{
 const ctx=await context(),ids=[...ctx.bindings.keys()],stock:Record<string,unknown>[]=[];
 const table=inventoryTable('Inventory');
 // Bound in batches to linked ACTIVE stock only. No Inventory scan or browser-wide inventory load.
 for(let i=0;i<ids.length;i+=100){let keys=ids.slice(i,i+100).map(id=>({id}));
  for(let attempt=0;keys.length&&attempt<4;attempt++){
   const r=await inventoryDdb.send(new BatchGetCommand({RequestItems:{[table]:{Keys:keys,ConsistentRead:true,
    ProjectionExpression:'id,#n,displayId,sku,updatedAt,purchasePrice,shippingCost,customFields,saleStartDate,saleEndDate,quantity,categoryId,categoryIds,deletedAt,isDeleted,listingPartition',ExpressionAttributeNames:{'#n':'name'}}}}));
   stock.push(...r.Responses?.[table]??[]);keys=(r.UnprocessedKeys?.[table]?.Keys??[]) as {id:string}[];
  }if(keys.length)throw Error('在庫情報の一部を取得できませんでした。再読み込みしてください。');
 }
 const items=stock.flatMap(s=>{const row=wholesaleRow(s,ctx.bindings.get(String(s.id))!.imageUrl,ctx.wholesaleId);return row?[row]:[];});
 const warnings:string[]=[];
 if(!ctx.wholesaleId)warnings.push('業者間カテゴリーが未設定です。設定で作成してから追加してください。');
 if(!ctx.manual.snapshot)warnings.push('eコンビニの同期情報がありません。EC出品で状態を取得してください。');
 const unavailable=ids.length-items.length;
 if(unavailable)warnings.push(`${unavailable}件は在庫が存在しない・売却済み・数量0等のため追加対象から除外しています。`);
 return {items,checkedAt:ctx.manual.snapshot?.checkedAt??null,snapshotVersion:ctx.manual.snapshot?.version??null,
  canEdit:editable(role)&&!!ctx.wholesaleId,unlinkedCount:ctx.unlinkedCount,ambiguousCount:ctx.ambiguousCount,warnings};
}
export function validWholesaleRequest(value:unknown):value is WholesaleSaveRequest{
 if(!value||typeof value!=='object')return false;const r=value as WholesaleSaveRequest;
 return typeof r.mutationId==='string'&&/^[a-zA-Z0-9_-]{8,100}$/.test(r.mutationId)&&typeof r.snapshotVersion==='string'&&r.snapshotVersion.length>0&&r.snapshotVersion.length<100&&
 Array.isArray(r.items)&&r.items.length>0&&r.items.length<=100&&new Set(r.items.map(v=>v?.id)).size===r.items.length&&r.items.every(v=>v&&typeof v.id==='string'&&/^[a-zA-Z0-9-]{8,80}$/.test(v.id)&&typeof v.expectedUpdatedAt==='string'&&Number.isFinite(Date.parse(v.expectedUpdatedAt)));
}
export async function saveWholesale(role:InventoryRole,actor:string,request:WholesaleSaveRequest):Promise<WholesaleSaveResult>{
 if(!editable(role))throw Error('編集権限がありません。');
 if(!validWholesaleRequest(request))throw Error('選択内容を確認してください。一度に100件まで追加できます。');
 const ctx=await context();if(!ctx.wholesaleId)throw Error('業者間カテゴリーを確認してください。');
 const results:WholesaleSaveResult['results']=[];
 for(const selected of request.items){try{
   const current=await getInventoryRaw(selected.id);
   if(!current)throw Error('商品が見つかりません。');
   // Reconcile unknown previous outcomes before considering any second write.
   if(inventoryCategoryIds(current).includes(ctx.wholesaleId)){results.push({id:selected.id,status:'already'});continue;}
   const binding=ctx.bindings.get(selected.id);
   if(!binding||!wholesaleRow(current,binding.imageUrl,ctx.wholesaleId))throw Error('出品状態または在庫が変わりました。再読み込みしてください。');
   if(ctx.manual.snapshot?.version!==request.snapshotVersion||current.updatedAt!==selected.expectedUpdatedAt)throw Error('情報が更新されています。再読み込みしてください。');
   const checks:InventoryTransaction=[{ConditionCheck:{TableName:ECONVENI_WORKFLOW_TABLE,Key:{pk:'ECONVENI#OBSERVED_CATALOG'},ConditionExpression:'#v=:v',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':request.snapshotVersion}}}];
   for(const productId of binding.productIds){
    const link=ctx.manual.links.find(l=>!l.disabled&&l.inventoryId===selected.id&&l.productId===productId);
    const flow=ctx.flows.find(f=>f.inventoryId===selected.id&&f.save.productId===productId);
    if(link)checks.push({ConditionCheck:{TableName:ECONVENI_WORKFLOW_TABLE,Key:{pk:manualLinkKey(link)},ConditionExpression:'revision=:r AND productId=:p AND (attribute_not_exists(disabled) OR disabled=:no)',ExpressionAttributeValues:{':r':link.revision,':p':productId,':no':false}}});
    if(flow&&!checks.some(c=>c.ConditionCheck?.Key?.pk===flow.pk))checks.push({ConditionCheck:{TableName:ECONVENI_WORKFLOW_TABLE,Key:{pk:flow.pk},ConditionExpression:'revision=:r',ExpressionAttributeValues:{':r':flow.revision}}});
   }
   const existingCategories=inventoryCategoryIds(current);
   if(current.categoryId&&existingCategories[0]!==current.categoryId)throw Error('主カテゴリーとカテゴリー一覧が一致しません。商品詳細で確認してください。');
   await persistInventoryWithCategories({id:selected.id,categoryIds:[...existingCategories,ctx.wholesaleId]},selected.expectedUpdatedAt,
    {current,history:{source:'業販カテゴリー追加',actor,operationId:request.mutationId},extraWrites:checks});
   results.push({id:selected.id,status:'saved'});
  }catch(error){results.push({id:selected.id,status:error instanceof InventorySaveError&&error.code==='UNCONFIRMED'?'unknown':'failed',message:error instanceof Error?error.message:'保存結果を確認してください。'});}
 }
 return {results};
}
