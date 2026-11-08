// Records the owner's confirmation of CURRENT rates. Does not invent historical validity.
// Default is a dry run. The manifest supports conditional, metadata-only rollback.
const fs = require('node:fs');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const db = DynamoDBDocumentClient.from(new DynamoDBClient({region:'us-west-2'}));
const table = 'ShippingRate-j6up24p7lnczdmklzjdt3vrp4y-NONE';
const dir = 'artifacts/customer-ai-20261108';
const marker = '2026-11-08 BELLO管理者確認：現在の登録額が現行の契約料金。適用開始日は確認できた日を表し、契約の実際の開始日は未確認。';
(async()=>{
  const apply=process.argv.includes('--apply');
  let key, rows=[];
  do { const p=await db.send(new ScanCommand({TableName:table,ExclusiveStartKey:key,ConsistentRead:true}));
    rows.push(...(p.Items||[]));key=p.LastEvaluatedKey; } while(key);
  const targets=rows.filter(r=>!r.effectiveFrom&&!r.effectiveTo&&r.status==null&&Number.isSafeInteger(r.price)&&r.price>=0);
  if(targets.length!==448 && targets.length!==0) throw new Error('Unexpected rate scope: review before applying');
  fs.mkdirSync(dir,{recursive:true});
  const path=dir+'/shipping-current-confirmation-manifest.json';
  if(apply&&targets.length){
    if(fs.existsSync(path))throw new Error('Existing manifest must be reviewed before retry');
    fs.writeFileSync(path,JSON.stringify({at:new Date().toISOString(),table,confirmation:marker,rows:targets},null,2));
  }
  let changed=0;
  for(const r of apply?targets:[]){
    const now=new Date().toISOString();
    await db.send(new UpdateCommand({TableName:table,Key:{id:r.id},
      UpdateExpression:'SET effectiveFrom=:day, #s=:verified, verifiedAt=:now, sourceReference=:source, #v=:next, updatedAt=:now, updatedBy=:by',
      ConditionExpression:'updatedAt=:old AND #v=:version AND (attribute_not_exists(effectiveFrom) OR attribute_type(effectiveFrom,:null))',
      ExpressionAttributeNames:{'#s':'status','#v':'version'},
      ExpressionAttributeValues:{':day':'2026-11-08',':verified':'VERIFIED',':now':now,':source':String(r.sourceReference||'')+'\n'+marker,':next':r.version+1,':by':'BELLO-owner-current-rate-confirmation-20261108',':old':r.updatedAt,':version':r.version,':null':'NULL'}
    }));
    const check=(await db.send(new GetCommand({TableName:table,Key:{id:r.id},ConsistentRead:true}))).Item;
    if(check.price!==r.price||check.rank!==r.rank||check.status!=='VERIFIED'||check.effectiveFrom!=='2026-11-08')throw new Error('Verification failed');
    changed++;
  }
  const result={at:new Date().toISOString(),mode:apply?'apply':'preview',eligible:targets.length,changed,pricesChanged:0,unknownPricesPreserved:rows.filter(r=>r.price==null).length,confirmation:marker};
  fs.writeFileSync(dir+'/shipping-current-confirmation-result.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
})().catch(e=>{console.error(e.name+': '+e.message);process.exitCode=1;});
