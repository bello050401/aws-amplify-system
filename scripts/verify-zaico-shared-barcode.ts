import assert from 'node:assert/strict';
import {DynamoDBDocumentClient,GetCommand,ScanCommand,TransactWriteCommand} from '@aws-sdk/lib-dynamodb';
import {createInventoryPersistence, type InventoryTransaction} from '../lib/inventory/categoryPersistenceCore';
import {InventorySaveError} from '../lib/inventory/conditionalUpdate';

async function main(){
 let transactions:InventoryTransaction[]=[];
 let duplicate=true;
 let existing:Record<string,unknown>|undefined;
 let cancelTransaction=false;
 const source={id:'new-source-page',sourceSystem:'ZAICO',sourceInventoryId:'75103701',barcode:'2025030605436',name:'別の販売分',quantity:0};
 const client={async send(command:unknown){
  if(command instanceof ScanCommand)return {Items:duplicate?[{id:'remaining-stock-page'}]:[]};
  if(command instanceof GetCommand)return command.input.TableName==='QA-Inventory'?{Item:existing}:{};
  if(command instanceof TransactWriteCommand){if(cancelTransaction)throw Object.assign(new Error('changed'),{name:'TransactionCanceledException'});transactions.push(command.input.TransactItems!);return {};}
  throw Error('unexpected command');
 }} as unknown as DynamoDBDocumentClient;
 const persistence=createInventoryPersistence(client,m=>'QA-'+m);
 // The production source failure is reproduced by the ordinary write policy.
 await assert.rejects(persistence.persistInventoryWithCategories(source),/別の商品/);
 assert.equal(transactions.length,0);
 // Opt-in is a separate server argument, never an imported/client field.
 await assert.rejects(persistence.persistInventoryWithCategories({...source,preserveZaicoSourceBarcode:true}),/別の商品/);
 await assert.rejects(persistence.persistInventoryWithCategories({...source,sourceSystem:'BELLO'},undefined,{preserveZaicoSourceBarcode:true}),/読み取れません/);
 await persistence.persistInventoryWithCategories(source,undefined,{preserveZaicoSourceBarcode:true});
 assert.equal(transactions.length,1);
 assert.equal(transactions[0][0].Put?.Item?.id,'new-source-page');
 assert.equal(transactions[0][0].Put?.Item?.quantity,0);
 assert.equal(transactions[0][0].Put?.Item?.barcode,source.barcode);
 assert.ok(transactions[0].some(x=>x.ConditionCheck?.Key?.id==='remaining-stock-page'));
 assert.ok(!transactions[0].some(x=>x.Put?.TableName==='QA-BarcodeClaim'));
 assert.ok(!transactions[0].some(x=>x.Update?.Key?.id==='remaining-stock-page'));
 // Manual QR assignment is still blocked after enabling the source adapter.
 await assert.rejects(persistence.persistInventoryWithCategories({id:'manual-page',barcode:source.barcode}),/別の商品/);
 duplicate=false;transactions=[];
 await persistence.persistInventoryWithCategories({...source,id:'unique-page'},undefined,{preserveZaicoSourceBarcode:true});
 assert.ok(transactions[0].some(x=>x.Put?.TableName==='QA-BarcodeClaim'));
 // Updates inherit the trusted source identity from the saved record. They
 // retain version guards, and a disappearing survivor becomes a conflict.
 duplicate=true;transactions=[];
 existing={...source,barcode:'old-source-label',updatedAt:'2026-10-20T00:00:00.000Z'};
 await persistence.persistInventoryWithCategories({id:source.id,barcode:source.barcode},String(existing.updatedAt),{preserveZaicoSourceBarcode:true});
 assert.equal(transactions[0][0].Update?.Key?.id,source.id);
 assert.match(transactions[0][0].Update?.ConditionExpression??'',/updatedAt/);
 assert.ok(transactions[0].some(x=>x.ConditionCheck?.Key?.id==='remaining-stock-page'));
 cancelTransaction=true;
 await assert.rejects(persistence.persistInventoryWithCategories({id:source.id,barcode:source.barcode},String(existing.updatedAt),{preserveZaicoSourceBarcode:true}),e=>e instanceof InventorySaveError&&e.code==='CONFLICT');
 cancelTransaction=false;transactions=[];
 existing={...source,updatedAt:'2026-10-20T00:00:00.000Z'};
 await persistence.persistInventoryWithCategories({id:source.id,quantity:0},String(existing.updatedAt),{preserveZaicoSourceBarcode:true});
 assert.equal(transactions[0].length,1,'unchanged barcode must not claim or merge another page');
 console.log('PASS: source duplicate reproduction; distinct pages preserved; no merge/claim takeover; manual and forged opt-in rejected; unique source barcode claimed');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
