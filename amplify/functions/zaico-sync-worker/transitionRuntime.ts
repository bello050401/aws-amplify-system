import {randomUUID,createHash} from 'node:crypto';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,ScanCommand,PutCommand,UpdateCommand,type ScanCommandOutput} from '@aws-sdk/lib-dynamodb';
import {S3Client,PutObjectCommand,GetObjectCommand,HeadObjectCommand,CopyObjectCommand} from '@aws-sdk/client-s3';
import {SecretsManagerClient,GetSecretValueCommand} from '@aws-sdk/client-secrets-manager';
import {createInventoryPersistence} from '../../../lib/inventory/categoryPersistenceCore';
import {createV2Client} from '../../../lib/zaico/transition/v2Client';
import {CONTROL_ID,transitionStore,type Control} from '../../../lib/zaico/transition/store';
import {runTransition,type TransitionPort} from '../../../lib/zaico/transition/runner';
import {sourceIdentityUpdate} from '../../../lib/zaico/transition/identity';
import {sourceDatesUpdate} from '../../../lib/zaico/transition/sourceDates';
import {restagePhoto} from '../../../lib/zaico/transition/images';
import type {Masters,Row} from '../../../lib/zaico/transition/mapping';
import {createLambdaSyncPort} from './lambdaSyncPort';

const db=DynamoDBDocumentClient.from(new DynamoDBClient({}),{marshallOptions:{removeUndefinedValues:true}});
const s3=new S3Client({}),secrets=new SecretsManagerClient({});
const table=(model:string)=>{
  const inventory=process.env.INVENTORY_TABLE_NAME;
  if(!inventory?.startsWith('Inventory-'))throw Error('在庫テーブルを確認できません。');
  return model+inventory.slice('Inventory'.length);
};
async function all(model:string){
  const rows:Row[]=[];let cursor;
  do{
    const page:ScanCommandOutput=await db.send(new ScanCommand({TableName:table(model),ExclusiveStartKey:cursor,ConsistentRead:true}));
    rows.push(...page.Items??[]);cursor=page.LastEvaluatedKey;
  }while(cursor);
  return rows;
}

export async function runConfiguredTransition():Promise<boolean>{
  const jobTable=process.env.ZAICO_TRANSITION_TABLE_NAME;
  if(!jobTable)return false;
  const store=transitionStore(db,jobTable);
  const first=await store.get(CONTROL_ID) as Control|undefined;
  if(!first||first.phase==='DISABLED')return false;
  // STOPPED also claims the legacy path: no fallback calls after migration.
  if(first.phase==='STOPPED')return true;
  if(!first.work&&(first.nextRunAt??0)>Date.now())return true;
  const owner=randomUUID();
  if(!await store.acquire(owner))return true;
  const bucket=process.env.STORAGE_BUCKET_NAME!;
  const persistence=createInventoryPersistence(db,table);
  const legacy=createLambdaSyncPort();
  let control=first;
  const runId=first.initialRunId;
  let token:string|undefined;
  const api=createV2Client({companyId:first.companyId,
    token:async()=>{
      if(!token){
        const secret=await secrets.send(new GetSecretValueCommand({SecretId:'bello/zaico-api-token'}));
        const parsed=JSON.parse(secret.SecretString??'{}');
        if(!parsed.configured||!parsed.token)throw Error('ZAICO APIの設定を確認してください。');
        token=parsed.token;
      }
      return token!;
    },
    beforeRequest:async(method)=>{
      await store.assertLease(owner);
      const current=await store.get(CONTROL_ID);
      if(!current||!['BASELINING','ACTIVE','FINALIZING'].includes(current.phase))throw Error('ZAICO連携は停止しています。');
      if(method!=='GET'&&(!current.initialCompletedAt||current.phase==='BASELINING'))throw Error('初回同期が完了するまでZAICOへ送信しません。');
    }});
  const copied=new Map<string,string>();
  async function preserveImage(key:string,sourceBucket=bucket){
    const signature=sourceBucket+'/'+key;
    if(copied.has(signature))return copied.get(signature)!;
    const destination=`zaico-transition/${runId}/images/${createHash('sha256').update(signature).digest('hex')}`;
    try{await s3.send(new HeadObjectCommand({Bucket:bucket,Key:destination}));}
    catch(e){
      if((e as any).$metadata?.httpStatusCode!==404)throw e;
      await s3.send(new CopyObjectCommand({Bucket:bucket,Key:destination,CopySource:encodeURIComponent(sourceBucket+'/'+key),MetadataDirective:'COPY'}));
      await s3.send(new HeadObjectCommand({Bucket:bucket,Key:destination}));
    }
    copied.set(signature,destination);return destination;
  }
  const port:TransitionPort={
    getControl:async()=>control,
    saveControl:async(next)=>{
      await store.assertLease(owner);
      control=await store.put(next,control.version) as Control;
      return control;
    },
    states:store.list,
    saveState:async(next)=>store.put(next,next.version),
    inventories:()=>all('Inventory'),
    inventory:persistence.getInventoryRaw,
    masters:async()=>{
      const [categories,locations,statuses]=await Promise.all(['Category','Location','StatusMaster'].map(all));
      const lists={Category:categories,Location:locations,StatusMaster:statuses};
      const masters:Masters={categories,locations,statuses,resolve:async(kind,name)=>{
        const field=kind==='StatusMaster'?'label':'name',list=lists[kind];
        const normalize=(s:string)=>s.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
        const found=list.find(row=>normalize(row[field]??'')===normalize(name));
        if(found)return found.id;
        const id=`zaico-${createHash('sha256').update(kind+'\0'+normalize(name)).digest('hex').slice(0,32)}`;
        const now=new Date().toISOString();
        const row={id,[field]:name,...(kind==='StatusMaster'?{code:id}:{}),sortOrder:0,isActive:true,createdAt:now,updatedAt:now,__typename:kind};
        try{await db.send(new PutCommand({TableName:table(kind),Item:row,ConditionExpression:'attribute_not_exists(id)'}));}
        catch(e){if((e as Error).name!=='ConditionalCheckFailedException')throw e;}
        list.push(row);return id;
      }};
      return masters;
    },
    archive:async(label,value)=>{
      const imageCopies:Record<string,string>={};
      if(label==='before-delete'){
        const local=(value as Row).local;
        for(const image of local?.images??[])for(const field of ['storageKey','thumbnailKey','mediumKey']){
          if(image[field])imageCopies[image[field]]=await preserveImage(image[field],image.sourceBucket??bucket);
        }
      }
      const bytes=Buffer.from(JSON.stringify({value,imageCopies}));
      const key=`zaico-transition/${first.initialRunId}/${label}/${randomUUID()}.json`;
      await s3.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:bytes,ContentType:'application/json',
        IfNoneMatch:'*',ChecksumSHA256:createHash('sha256').update(bytes).digest('base64')}));
      const head=await s3.send(new HeadObjectCommand({Bucket:bucket,Key:key}));
      if(head.ContentLength!==bytes.length)throw Error('同期前バックアップの保存を確認できません。');
      return key;
    },
    readArchive:async(key)=>{
      if(!key.startsWith(`zaico-transition/${first.initialRunId}/`))throw Error('同期データの保存先が一致しません。');
      const object=await s3.send(new GetObjectCommand({Bucket:bucket,Key:key}));
      return JSON.parse(await object.Body!.transformToString()).value;
    },
    saveInventory:async(row,expected)=>{
      await store.assertLease(owner);
      const identity=sourceIdentityUpdate(table('Inventory'),row,expected);
      if(identity){
        const result=await db.send(new UpdateCommand(identity));
        if(!result.Attributes)throw Error('同期後の在庫を確認できません。');
        return result.Attributes;
      }
      const result=await persistence.persistInventoryWithCategories({...row,listUpdatedAt:row.listUpdatedAt??new Date().toISOString()},expected,{preserveZaicoSourceBarcode:true});
      const saved=await persistence.getInventoryRaw(result.id);
      if(!saved)throw Error('同期後の在庫を確認できません。');
      return saved;
    },
    saveSourceDates:async(row,remote,includeUpdated)=>{
      const command=sourceDatesUpdate(table('Inventory'),row,remote,includeUpdated);
      if(!command)return row;
      await store.assertLease(owner);
      const result=await db.send(new UpdateCommand(command));
      if(!result.Attributes)throw Error('商品の日時を確認できません。');
      return result.Attributes;
    },
    deleteInventory:async(row)=>{
      await store.assertLease(owner);
      await persistence.deleteInventoryWithCategories(row.id,row.updatedAt,'ZAICO暫定同期');
    },
    generateSku:legacy.generateSku,
    readPrimaryImage:async(row)=>{
      const photo=restagePhoto(row);
      if(!photo)throw Error('送信する仕入写真を確認できません。');
      const {image}=photo;
      // Procurement originals belong to this bucket, never an arbitrary URL.
      if(image.sourceBucket&&image.sourceBucket!==bucket)throw Error('仕入写真の保存先を確認できません。');
      if(!image.storageKey.startsWith('inventory/'))throw Error('仕入写真の保存先を確認できません。');
      const object=await s3.send(new GetObjectCommand({Bucket:bucket,Key:image.storageKey}));
      if(!object.Body||!object.ContentLength||object.ContentLength>5*1024*1024){if(object.Body&&'destroy' in object.Body)object.Body.destroy();throw Error('ZAICO写真は5MB以内で登録してください。BELLOの原本は保持しています。');}
      const bytes=Buffer.from(await object.Body.transformToByteArray());
      if(bytes.length!==object.ContentLength)throw Error('仕入写真の読み込みが完了していません。');
      if(image.originalHash&&createHash('sha256').update(bytes).digest('hex')!==image.originalHash)throw Error('仕入写真の内容が登録時と一致しません。');
      const mime=bytes[0]===255&&bytes[1]===216?'image/jpeg':bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':null;
      if(!mime)throw Error('ZAICOへの写真送信はJPEG・PNGに対応しています。');
      return `data:${mime};base64,${bytes.toString('base64')}`;
    },
    syncImage:async(row,remote,ownUploadedUrl)=>{
      const url=remote.item_image?.url;
      if(!url)return row; // Missing URL does not prove image deletion.
      if(url===ownUploadedUrl)return row;
      const images=Array.isArray(row.images)?row.images:[];
      const old=images.find((i:Row)=>i.sourceSystem==='ZAICO');
      if(old?.sourceUrl===url)return row;
      if(old)for(const field of ['storageKey','thumbnailKey','mediumKey'])if(old[field])await preserveImage(old[field],old.sourceBucket??bucket);
      const image=await legacy.downloadAndImportImage(url);
      return {...row,images:[{...image,type:'NORMAL',sortOrder:0,isPrimary:true,sourceSystem:'ZAICO',sourceUrl:url},
        ...images.filter((i:Row)=>i!==old).map((i:Row,index:number)=>({...i,sortOrder:index+1,isPrimary:false}))]};
    },
    history:async(row,changes)=>{
      if(!Object.keys(changes).length)return;
      const now=new Date().toISOString();
      await db.send(new PutCommand({TableName:table('InventoryHistory'),Item:{id:randomUUID(),inventoryId:row.id,changedAt:now,changedBy:'ZAICO暫定同期',
        fieldName:'ZAICO同期',oldValue:'同期前データはバックアップに保存',newValue:JSON.stringify(Object.keys(changes)),createdAt:now,updatedAt:now,__typename:'InventoryHistory'}}));
    },
    api,now:Date.now,deadline:Date.now()+210_000,
  };
  try{await runTransition(port);}
  catch(e){
    const latest=await store.get(CONTROL_ID);
    if(latest&&latest.phase!=='STOPPED')await store.put({...latest,lastError:e instanceof Error?e.message:'同期に失敗しました。',nextRunAt:Date.now()+60_000},latest.version);
    console.error('[zaico-transition]',e instanceof Error?e.name:'Error');
  }finally{await store.release(owner);}
  return true;
}
