import {DeleteCommand,PutCommand,QueryCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
export type Addressee={id:string;name:string;suffix:'様'|'御中';version:string};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export async function manageAddressees(db:DynamoDBDocumentClient,table:string,raw:unknown){
 const i=raw as {operation?:string;id?:string;name?:string;suffix?:string;version?:string};
 const invalid=()=>({ok:false,code:'INVALID',message:'宛名と敬称を確認してください。'});
 if(!i||!['list','save','delete'].includes(i.operation??''))return invalid();
 if(i.operation==='list'){
  const items:Addressee[]=[];let cursor:Record<string,unknown>|undefined;
  do{const r=await db.send(new QueryCommand({TableName:table,KeyConditionExpression:'directory = :d',ExpressionAttributeValues:{':d':'BELLO'},ConsistentRead:true,ExclusiveStartKey:cursor}));items.push(...(r.Items??[]).map(x=>({id:x.id,name:x.name,suffix:x.suffix,version:x.version})));cursor=r.LastEvaluatedKey;}while(cursor);
  return {ok:true,items:items.sort((a,b)=>a.name.localeCompare(b.name,'ja'))};
 }
 if(!i.id||!uuid.test(i.id)||i.version!==undefined&&(typeof i.version!=='string'||!uuid.test(i.version)))return invalid();
 const key={directory:'BELLO',id:i.id};
 try{
  if(i.operation==='delete'){
   if(!i.version)return invalid();
   await db.send(new DeleteCommand({TableName:table,Key:key,ConditionExpression:'#v = :v',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':i.version}}));return {ok:true};
  }
  if(typeof i.name!=='string'||!i.name.trim()||i.name.trim().length>100||/[\u0000-\u001f\u007f]/u.test(i.name)||!['様','御中'].includes(i.suffix??''))return invalid();
  const item={...key,name:i.name.trim(),suffix:i.suffix,version:crypto.randomUUID()};
  await db.send(new PutCommand({TableName:table,Item:item,ConditionExpression:i.version?'#v = :v':'attribute_not_exists(id)',...(i.version?{ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':i.version}}:{})}));
  return {ok:true,item:{id:item.id,name:item.name,suffix:item.suffix,version:item.version}};
 }catch(e){if((e as Error).name==='ConditionalCheckFailedException')return {ok:false,code:'CONFLICT',message:'宛名が別の画面で変更されています。一覧を再読み込みしてください。'};throw e;}
}
