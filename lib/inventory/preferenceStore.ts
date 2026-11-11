import {GetCommand,PutCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {preferenceSections,sanitizePreference,type PreferenceSection} from './preferenceSections';
export function createPreferenceStore(db:DynamoDBDocumentClient,TableName:string){
 const key=(owner:string,section:PreferenceSection)=>({pk:'PREF#'+owner,sk:section});
 async function read(owner:string,section:PreferenceSection){return (await db.send(new GetCommand({TableName,Key:key(owner,section),ConsistentRead:true}))).Item;}
 return {
  async get(owner:string){return Object.fromEntries(await Promise.all((Object.keys(preferenceSections) as PreferenceSection[]).map(async section=>{const item=await read(owner,section);return [section,item?{revision:item.revision,value:sanitizePreference(section,item.value)}:null];})));},
  async save(owner:string,section:PreferenceSection,revision:number,value:unknown){
   if(!Object.hasOwn(preferenceSections,section)||!Number.isSafeInteger(revision)||revision<0)throw Error('設定の内容を確認してください。');
   const clean=sanitizePreference(section,value);
   try{await db.send(new PutCommand({TableName,Item:{...key(owner,section),revision:revision+1,value:clean,updatedAt:new Date().toISOString()},ConditionExpression:revision?'revision=:r':'attribute_not_exists(pk)',...(revision?{ExpressionAttributeValues:{':r':revision}}:{})}));}
   catch(error){
    // Response loss or repeat save: accept an identical persisted result. A
    // different value always remains a conflict, never a blind last-write-wins.
    const current=await read(owner,section);
    if(current&&JSON.stringify(current.value)===JSON.stringify(clean))return {revision:current.revision as number};
    throw error;
   }
   return {revision:revision+1};
  }
 };
}
