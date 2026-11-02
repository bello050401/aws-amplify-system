import assert from 'node:assert/strict';
import {test} from 'node:test';
import {QueryCommand,GetCommand,ScanCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {CopyObjectCommand,DeleteObjectCommand,type S3Client} from '@aws-sdk/client-s3';
import {createYahooPaymentStockPorts} from '../lib/saleCandidates/yahooPaymentStock';
function fixture(failAt=0){
 const copies:any[]=[],deletes:string[]=[],reads:string[]=[];
 const asset={id:'batch#A#photo',photoBatchId:'batch',status:'READY',sequence:1,isDeleted:false,inventoryIsPrimary:true,declaredProcessedMimeType:'image/jpeg',declaredProcessedSha256:'hash'};
 const db={send:async(c:any)=>{assert.equal(c.input.TableName==='photos'||c.input.TableName==='Category',true);if(c instanceof ScanCommand)return {Items:[{id:'sold',name:'売り切れ'}]};if(c instanceof GetCommand){reads.push(c.input.Key!.PK);return {Item:{id:c.input.Key!.PK==='BATCH#foreign'?'foreign':'batch',inventoryId:c.input.Key!.PK==='BATCH#foreign'?'other-stock':'source'}};}assert(c instanceof QueryCommand);if(c.input.IndexName==='GSI2')return {Items:[{id:'batch',inventoryId:'source'},{id:'foreign',inventoryId:'source'}]};assert.equal(c.input.ExpressionAttributeValues![':pk'],'BATCH#batch');return {Items:[asset,{...asset,id:'batch#A#deleted',isDeleted:true}]};}} as unknown as DynamoDBDocumentClient;
 const s3={send:async(c:any)=>{if(c instanceof CopyObjectCommand){copies.push(c.input);if(copies.length===failAt)throw Error('copy failed');return {};}assert(c instanceof DeleteObjectCommand);deletes.push(c.input.Key!);return {};}} as unknown as S3Client;
 const ports=createYahooPaymentStockPorts({db,table:n=>n,s3,inventoryBucket:'inventory-bucket',photoBucket:'photo-bucket',photoTable:'photos',nextSku:async()=>'B123'});
 return {ports,copies,deletes,reads};
}
test('payment split copies verified legacy and PhotoStation processed photos, not deleted/unlinked photos or originals',async()=>{
 const f=fixture(),images=await f.ports.copyPhotos({id:'source',images:[{storageKey:'inventory/source.jpg',thumbnailKey:'inventory/thumb.jpg',mediumKey:'inventory/medium.jpg',type:'NORMAL',sortOrder:0}]},'attempt') as any[];
 assert.equal(images.length,2);assert.equal(f.copies.length,5);assert(f.copies.some(c=>c.CopySource==='photo-bucket/photo-batches/batch/processed/batch%23A%23photo.jpg'));assert(f.copies.every(c=>!c.CopySource.includes('original')&&!c.CopySource.includes('deleted')&&!c.CopySource.includes('foreign')));assert.equal(new Set(f.copies.map(c=>c.Key)).size,5);assert(images.every(p=>p.storageKey.startsWith('inventory/yahoo-payment/')));
 await f.ports.discardPhotos(images);assert.equal(f.deletes.length,5);assert(f.deletes.every(k=>k.startsWith('inventory/yahoo-payment/')));
});
test('failed photo copy cleans only created copies, preserving all source objects',async()=>{const f=fixture(2);await assert.rejects(f.ports.copyPhotos({id:'source',images:[{storageKey:'inventory/source.jpg',thumbnailKey:'inventory/thumb.jpg',type:'NORMAL',sortOrder:0}]},'attempt'));assert.equal(f.deletes.length,1);assert.equal(f.deletes[0],f.copies[0].Key);});
test('untrusted image key rejected and cleanup never deletes source prefixes',async()=>{const f=fixture();await assert.rejects(f.ports.copyPhotos({id:'source',images:[{storageKey:'secrets/source.jpg',type:'NORMAL',sortOrder:0}]},'attempt'));await f.ports.discardPhotos([{storageKey:'inventory/source.jpg',thumbnailKey:'other/file.jpg'}]);assert.equal(f.copies.length,0);assert.equal(f.deletes.length,0);});
