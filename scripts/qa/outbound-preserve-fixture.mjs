/** Isolated database/transport for real outbound-service tests and UI rehearsal. */
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';
import * as commands from '@aws-sdk/lib-dynamodb';
import * as types from '../../lib/outbound/types.ts';
import * as kawagoe from '../../lib/outbound/kawagoe.ts';
import * as arrivalTypes from '../../lib/outbound/arrivalTypes.ts';
import * as policy from '../../lib/outbound/inventoryPolicy.ts';
import * as split from '../../lib/outbound/splitInventory.ts';
import * as categories from '../../lib/inventory/categories.ts';
import * as custom from '../../lib/inventory/customFieldsCodec.ts';
import * as human from '../../lib/inventory/humanEdits.ts';

export function createOutboundFixture({templateType='KAWAGOE_V1',sender='EMAIL',locationId='office',database,onError=()=>{}}={}) {
  const itemId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',destinationId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const tables=new Map(),effects={emails:[],copies:[],merges:0,mergeReads:0,categoryWrites:[],failEmail:false,failCompletion:false,failArrivalFor:null,failArrivalFinal:false,transactions:[]};
  const rows=model=>{if(!tables.has(model))tables.set(model,new Map());return tables.get(model);};
  const read=(model,id)=>structuredClone(rows(model).get(id));
  const put=(model,value)=>rows(model).set(value.id,structuredClone(value));
  const original={id:itemId,sku:'QA-ONLY',name:'確認用チェア',barcode:'202610220001',quantity:5,categoryId:'sale',categoryIds:['sale','move'],locationId,customFields:'{}',updatedAt:'2026-10-22T00:00:00Z',createdAt:'2026-10-01T00:00:00Z',images:[]};
  put('Inventory',original);
  put('OutboundDestination',{id:destinationId,name:'川越',categoryId:'move',locationId:'kawagoe',templateType,sender,isActive:true,sortOrder:1,preparationStatus:'READY',template:'[]',fileNamePattern:'{destination}_{date}_{id}.csv',emailTo:'qa@example.invalid',emailFrom:'qa@example.invalid'});
  for(const [id,name] of [['sale','販売中'],['move','川越移動予定']])put('Category',{id,name,isActive:true});
  for(const [id,name] of [['office','所沢事務所'],['kawagoe','イエローテイル川越']])put('Location',{id,name,isActive:true});
  for(const categoryId of original.categoryIds)put('InventoryCategory',{id:itemId+':'+categoryId,inventoryId:itemId,categoryId});
  const resolve=(token,op)=>op.ExpressionAttributeNames?.[token]??token;
  function check(op){
    if(!op.ConditionExpression)return;
    const row=rows(op.TableName).get(op.Key?.id??op.Item.id)??{},v=op.ExpressionAttributeValues??{};
    for(const part of op.ConditionExpression.split(/\s+AND\s+/)){
      let m=part.match(/^attribute_not_exists\(([^)]+)\)$/),ok;
      if(m)ok=row[resolve(m[1],op)]===undefined;
      else if((m=part.match(/^attribute_exists\(([^)]+)\)$/)))ok=row[resolve(m[1],op)]!==undefined;
      else if((m=part.match(/^(\S+)\s+IN\s*\(([^)]+)\)$/)))ok=m[2].split(',').some(k=>v[k.trim()]===row[resolve(m[1],op)]);
      else if((m=part.match(/^(\S+?)\s*=\s*(:\S+)$/)))ok=row[resolve(m[1],op)]===v[m[2]];
      else throw Error('Unsupported fixture condition: '+part);
      if(!ok)throw Object.assign(Error('Condition rejected'),{name:'ConditionalCheckFailedException'});
    }
  }
  function apply(op,kind){
    if(kind==='ConditionCheck')return;
    if(kind==='Put'){put(op.TableName,op.Item);return;}
    if(kind==='Delete'){rows(op.TableName).delete(op.Key.id);return;}
    const row=read(op.TableName,op.Key.id)??{...op.Key},v=op.ExpressionAttributeValues??{};
    for(const match of op.UpdateExpression.matchAll(/(?:^|\s)(SET|REMOVE)\s+(.+?)(?=\s+(?:SET|REMOVE)\s+|$)/g)){
      for(const part of match[2].split(',')){
        const [key,value]=part.trim().split(/\s*=\s*/);
        if(match[1]==='REMOVE')delete row[resolve(key,op)];else row[resolve(key,op)]=v[value];
      }
    }
    put(op.TableName,row);
  }
  const db=database??{send:async command=>{
    const op=command.input;
    // DynamoDB rejects reserved attribute names even when our in-memory parser
    // understands them. Keep the production incident reproducible here too.
    for(const action of op.TransactItems??[{operation:op}])for(const value of Object.values(action)){
      if(/(?<![#:])\bsnapshot\b/.test([value.UpdateExpression,value.ConditionExpression,value.FilterExpression,value.ProjectionExpression].filter(Boolean).join(' ')))throw Object.assign(Error('Reserved keyword: snapshot'),{name:'ValidationException'});
    }
    if(command instanceof commands.GetCommand)return {Item:read(op.TableName,op.Key.id)};
    if(command instanceof commands.ScanCommand){
      let items=[...rows(op.TableName).values()];
      if(op.FilterExpression?.includes('batchId ='))items=items.filter(r=>r.batchId===op.ExpressionAttributeValues[':id']);
      if(op.FilterExpression?.includes('contains(categoryIds'))items=items.filter(r=>!r.deletedAt&&categories.inventoryCategoryIds(r).includes(op.ExpressionAttributeValues[':cat']));
      return {Items:structuredClone(items)};
    }
    if(command instanceof commands.TransactWriteCommand){
      effects.transactions.push(structuredClone(op));
      if(effects.failArrivalFor&&op.TransactItems.some(a=>a.Update?.TableName==='Inventory'&&a.Update.Key.id===effects.failArrivalFor))throw Error('Injected arrival failure');
      if(effects.failCompletion&&op.TransactItems.some(a=>a.Put?.TableName==='InventoryHistory'))throw Error('Injected database failure');
      op.TransactItems.forEach(action=>check(Object.values(action)[0]));
      op.TransactItems.forEach(action=>{const [kind,value]=Object.entries(action)[0];apply(value,kind);});return {};
    }
    if(command instanceof commands.UpdateCommand||command instanceof commands.PutCommand){if(effects.failArrivalFinal&&op.TableName==='OutboundBatch'&&(op.ExpressionAttributeValues?.[':status']==='COMPLETED'||op.ExpressionAttributeValues?.[':done']==='COMPLETED'))throw Error('Injected final journal failure');check(op);apply(op,command instanceof commands.PutCommand?'Put':'Update');return {};}
    throw Error('Unsupported fixture command');
  }};
  const stubs={
    'server-only':{},'node:crypto':crypto,'@aws-sdk/lib-dynamodb':commands,
    './transactionRetry':{sendOutboundTransaction:(db,c)=>db.send(c)},
    '@/lib/inventory/categoryPersistence':{inventoryDdb:db,inventoryTable:n=>n,getInventoryRaw:async id=>(await db.send(new commands.GetCommand({TableName:'Inventory',Key:{id},ConsistentRead:true}))).Item,categoryLinkChanges:(id,before,after,now)=>{effects.categoryWrites.push({id,before,after});return [...before.filter(c=>!after.includes(c)).map(c=>({Delete:{TableName:'InventoryCategory',Key:{id:id+':'+c}}})),...after.map(c=>({Put:{TableName:'InventoryCategory',Item:{id:id+':'+c,inventoryId:id,categoryId:c,createdAt:now}}}))];}},
    '@/lib/inventory/categories':categories,'@/lib/inventory/humanEdits':human,'@/lib/inventory/customFieldsCodec':custom,
    '@/lib/inventory/inventoryPage':{clearInventoryCountCache(){}},'@/lib/mobile/inventoryThumbnails':{inventoryThumbnails:async items=>items.map(r=>({id:r.id,thumbnailUrl:null}))},
    './arrivalTypes':arrivalTypes,
    './productThumbnail':{outboundThumbnailFields:()=>({})},'./types':types,'./kawagoe':kawagoe,'./inventoryPolicy':policy,'./splitInventory':split,
    './splitPhotos':{nextSplitSku:async()=>`QA-SPLIT-${effects.copies.length+1}`,prepareSplitPhotos:async(source,item)=>{effects.copies.push(item.splitInventoryId);return [];},removeUnsentSplitPhotos:async()=>{}},
    './mergePersistence':{findOutboundMergeTarget:async()=>{effects.mergeReads++;return null;},applyOutboundMerge:async()=>{effects.merges++;return false;}},
    './email':{assertOutboundEmailReady:async()=>{},sendOutboundEmail:async batch=>{if(effects.failEmail)throw Error('Injected email failure');effects.emails.push(kawagoe.kawagoeAttachments(batch));return 'isolated-qa-message';},isDefiniteEmailFailure:()=>true},
  };
  const exports={};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../../lib/outbound/service.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:name=>{if(!(name in stubs))throw Error('Unstubbed dependency: '+name);return stubs[name];},Date,JSON,Error,console:{error:onError},Set,Map,Number,Object,Array});
  stubs['./service']=exports;
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../../lib/outbound/arrivalService.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:name=>{if(!(name in stubs))throw Error('Unstubbed dependency: '+name);return stubs[name];},Date,JSON,Error,console:{error:onError},Set,Map,Number,Object,Array});
  return {api:exports,itemId,destinationId,original,effects,read,put,rows,seed:async()=>{for(const [model,items] of tables)for(const item of items.values())await db.send(new commands.PutCommand({TableName:model,Item:item}));},prepare:async(quantity=5,id=crypto.randomUUID())=>exports.prepareOutbound(id,destinationId,[{id:itemId,updatedAt:(await db.send(new commands.GetCommand({TableName:'Inventory',Key:{id:itemId},ConsistentRead:true}))).Item.updatedAt,quantity,detailNote:'確認用の備考',exportName:'送信データ用の商品名'}],'QA','2026-10-23')};
}
