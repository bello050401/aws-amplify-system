import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PutCommand,DeleteCommand,QueryCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {manageAddressees} from '../lib/invoicing/addressees';
test('宛名の登録・一覧・編集・削除、競合、最小保存項目',async()=>{
 const rows=new Map<string,any>();const db={send:async(c:any)=>{const i=c.input;if(c instanceof QueryCommand)return {Items:[...rows.values()]};const id=i.Item?.id??i.Key.id,old=rows.get(id);if(c instanceof PutCommand){if(i.ExpressionAttributeValues?old?.version!==i.ExpressionAttributeValues[':v']:!!old)throw Object.assign(Error(),{name:'ConditionalCheckFailedException'});rows.set(id,i.Item);return {};}assert.ok(c instanceof DeleteCommand);if(old?.version!==i.ExpressionAttributeValues[':v'])throw Object.assign(Error(),{name:'ConditionalCheckFailedException'});rows.delete(id);return {};}} as unknown as DynamoDBDocumentClient;
 const id=randomUUID();const a=await manageAddressees(db,'directory',{operation:'save',id,name:'テスト宛名',suffix:'様'});assert.equal(a.ok,true);assert.deepEqual(Object.keys(rows.get(id)).sort(),['directory','id','name','suffix','version']);
 assert.equal((await manageAddressees(db,'directory',{operation:'list'}) as any).items.length,1);
 const version=rows.get(id).version;assert.equal((await manageAddressees(db,'directory',{operation:'save',id,version,name:'変更した宛名',suffix:'御中'})).ok,true);
 assert.equal((await manageAddressees(db,'directory',{operation:'delete',id,version})).ok,false);
 assert.equal((await manageAddressees(db,'directory',{operation:'delete',id,version:rows.get(id).version})).ok,true);assert.equal(rows.size,0);
 for(const name of ['', 'a\nsecret','a'.repeat(101)])assert.equal((await manageAddressees(db,'directory',{operation:'save',id,name,suffix:'様'})).ok,false);
});
