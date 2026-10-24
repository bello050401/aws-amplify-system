import assert from 'node:assert/strict';
import {DynamoDBDocumentClient,GetCommand,TransactWriteCommand} from '@aws-sdk/lib-dynamodb';
import {createInventoryPersistence, type InventoryTransaction} from '../lib/inventory/categoryPersistenceCore';
import {InventorySaveError,InventoryMutationRejected} from '../lib/inventory/conditionalUpdate';

async function main(){
 const records=new Map<string,Record<string,any>>();
 const transactions:InventoryTransaction[]=[];
 let cancelTransaction=false;
 const client={async send(command:unknown){
  if(command instanceof GetCommand){
   assert.equal(command.input.TableName,'QA-Inventory','No barcode claim lookup or whole-inventory scan');
   return {Item:records.get(String(command.input.Key!.id))};
  }
  if(command instanceof TransactWriteCommand){
   if(cancelTransaction)throw Object.assign(new Error('changed'),{name:'TransactionCanceledException'});
   const tx=command.input.TransactItems!;
   for(const entry of tx){
    const op=entry.Put??entry.Update??entry.Delete??entry.ConditionCheck;
    assert.notEqual(op?.TableName,'QA-BarcodeClaim','Shared codes must never acquire an exclusive claim');
    if(entry.Put?.TableName==='QA-Inventory'){
     const row=entry.Put.Item!;if(records.has(String(row.id)))throw Object.assign(Error('exists'),{name:'TransactionCanceledException'});
     records.set(String(row.id),{...row});
    }
    if(entry.Update?.TableName==='QA-Inventory'){
     const u=entry.Update,row=records.get(String(u.Key!.id))!;
     assert.equal(row.updatedAt,u.ExpressionAttributeValues![':version']);
     const next={...row};
     for(const [alias,key] of Object.entries(u.ExpressionAttributeNames!)){
      const v=':v'+alias.slice(2);if(v in u.ExpressionAttributeValues!)next[key]=u.ExpressionAttributeValues![v];else delete next[key];
     }records.set(String(u.Key!.id),next);
    }
    if(entry.Delete?.TableName==='QA-Inventory')records.delete(String(entry.Delete.Key!.id));
   }transactions.push(tx);return {};
  }
  throw Error('Unexpected request: no barcode uniqueness scan is allowed');
 }} as unknown as DynamoDBDocumentClient;
 const p=createInventoryPersistence(client,m=>'QA-'+m);
 const base={name:'同じ椅子',quantity:5,barcode:' 2025030605436 ',categoryIds:[],images:[{storageKey:'inventory/original.jpg'}]};
 const first=await p.persistInventoryWithCategories({...base,id:'remaining',sku:'B000001'});
 const second=await p.persistInventoryWithCategories({...base,id:'sold',sku:'B000002',quantity:2});
 assert.notEqual(first.id,second.id);
 assert.equal(records.get('remaining')!.barcode,records.get('sold')!.barcode);
 assert.equal(records.get('remaining')!.quantity,5);
 assert.equal(records.get('sold')!.quantity,2);
 const original=structuredClone(records.get('remaining'));
 const edited=await p.persistInventoryWithCategories({id:'sold',quantity:1,note:'出荷指示用'},second.updatedAt);
 assert.deepEqual(records.get('remaining'),original,'Editing sold stock cannot update remaining stock');
 await p.persistInventoryWithCategories({id:'sold',barcode:'2025030605436'},edited.updatedAt);
 await p.persistInventoryWithCategories({...base,id:'zaico',sourceSystem:'ZAICO',sourceInventoryId:'75103701'},undefined,{preserveZaicoSourceBarcode:true});
 await assert.rejects(p.persistInventoryWithCategories({id:'invalid',barcode:'bad\ncode'}),e=>e instanceof InventoryMutationRejected&&e.code==='BARCODE_INVALID');
 await assert.rejects(p.persistInventoryWithCategories({id:'sold',quantity:0},second.updatedAt),e=>e instanceof InventorySaveError&&e.code==='CONFLICT');
 cancelTransaction=true;
 await assert.rejects(p.persistInventoryWithCategories({...base,id:'conflict'}),e=>e instanceof InventorySaveError&&e.code==='CONFLICT');
 cancelTransaction=false;
 await p.deleteInventoryWithCategories('sold',String(records.get('sold')!.updatedAt));
 assert.equal(records.has('sold'),false);assert.deepEqual(records.get('remaining'),original);
 assert.equal(records.get('zaico')!.barcode,'2025030605436');
 console.log('PASS: same-code create/duplicate/update/source import; separate quantities; delete isolation; format validation; stale version and atomic-write conflicts; no uniqueness scans or claims');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
