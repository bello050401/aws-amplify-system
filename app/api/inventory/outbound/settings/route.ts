import {NextResponse} from 'next/server';
import {ScanCommand,UpdateCommand,GetCommand,type ScanCommandOutput} from '@aws-sdk/lib-dynamodb';
import {getMobileSession} from '@/lib/mobile/session';
import {inventoryDdb as db,inventoryTable as table} from '@/lib/inventory/categoryPersistence';
import {requireUuid} from '@/lib/outbound/service';
import {isOutboundRequestOriginAllowed} from '@/lib/outbound/requestOrigin';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
async function masters(model:string){let key:ScanCommandOutput['LastEvaluatedKey'];const result:NonNullable<ScanCommandOutput['Items']>=[];do{const page=await db.send(new ScanCommand({TableName:table(model),ExclusiveStartKey:key,ConsistentRead:true}));result.push(...page.Items??[]);key=page.LastEvaluatedKey;}while(key);return result.filter(x=>x.isActive!==false).map(x=>({id:x.id,name:x.name}));}
export async function GET(){const session=await getMobileSession();if(!session.ok||session.role!=='ADMIN')return NextResponse.json({error:'管理者のみ設定できます。'},{status:403,headers});
 const [categories,locations]=await Promise.all([masters('Category'),masters('Location')]);return NextResponse.json({categories,locations,connectionStatus:'NOT_CONNECTED'},{headers});}
export async function POST(request:Request){const session=await getMobileSession();if(!session.ok||session.role!=='ADMIN')return NextResponse.json({error:'管理者のみ設定できます。'},{status:403,headers});
 if(!isOutboundRequestOriginAllowed(request))return NextResponse.json({error:'不正な送信元です。'},{status:403,headers});
 try{const input=await request.json();requireUuid(input.id);requireUuid(input.categoryId);requireUuid(input.locationId);
   if(typeof input.expectedUpdatedAt!=='string'||!Number.isFinite(Date.parse(input.expectedUpdatedAt)))throw new Error('設定を読み直してください。');
   if(typeof input.slackChannelId!=='string'||(input.slackChannelId&&!/^[CG][A-Z0-9]{8,}$/u.test(input.slackChannelId)))throw new Error('SlackのチャンネルIDを確認してください。');
   const refs=await Promise.all(['Category','Location'].map((model,i)=>db.send(new GetCommand({TableName:table(model),Key:{id:i?input.locationId:input.categoryId},ConsistentRead:true}))));
   if(refs.some(x=>!x.Item||x.Item.isActive===false))throw new Error('カテゴリと保管場所を選び直してください。');
   await db.send(new UpdateCommand({TableName:table('OutboundDestination'),Key:{id:input.id},UpdateExpression:'SET categoryId=:c, locationId=:l, slackChannelId=:s, updatedAt=:now',ConditionExpression:'attribute_exists(id) AND updatedAt=:old',ExpressionAttributeValues:{':c':input.categoryId,':l':input.locationId,':s':input.slackChannelId||null,':now':new Date().toISOString(),':old':input.expectedUpdatedAt}}));
   return NextResponse.json({saved:true},{headers});
 }catch(error){return NextResponse.json({error:error instanceof Error&&error.name==='ConditionalCheckFailedException'?'別の端末で設定が変更されています。読み直してください。':error instanceof Error?error.message:'保存できませんでした。'},{status:409,headers});}}
