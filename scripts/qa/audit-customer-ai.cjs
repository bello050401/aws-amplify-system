const fs=require('node:fs');
const {DynamoDBClient}=require('@aws-sdk/client-dynamodb');
const {DynamoDBDocumentClient,ScanCommand}=require('@aws-sdk/lib-dynamodb');
const {LambdaClient,GetFunctionConfigurationCommand}=require('@aws-sdk/client-lambda');
const db=DynamoDBDocumentClient.from(new DynamoDBClient({region:'us-west-2'}));
const suffix='-j6up24p7lnczdmklzjdt3vrp4y-NONE';
(async()=>{
 const summary={at:new Date().toISOString(),tables:{}};
 for(const name of ['ShippingRate','ReplyRule','ExternalResearchCache','ListingDraft','Message','ReplyDraft']){
  let key,rows=[];do{const r=await db.send(new ScanCommand({TableName:name+suffix,ExclusiveStartKey:key}));rows.push(...(r.Items||[]));key=r.LastEvaluatedKey;}while(key);
  const s={count:rows.length};
  if(name==='ShippingRate')Object.assign(s,{providers:[...new Set(rows.map(r=>r.provider))],services:[...new Set(rows.map(r=>r.service))],origins:[...new Set(rows.map(r=>r.originPrefecture))],status:count(rows,'status'),withVerified:rows.filter(r=>r.verifiedAt).length,withPeriod:rows.filter(r=>r.effectiveFrom).length,withSource:rows.filter(r=>r.sourceReference).length,areas:[...new Set(rows.map(r=>r.destinationArea))],versions:count(rows,'version')});
  if(name==='ReplyRule')Object.assign(s,{categories:count(rows,'category'),enabled:rows.filter(r=>r.enabled&&!r.deletedAt).length});
  if(name==='ListingDraft')Object.assign(s,{methods:count(rows,'shippingMethod'),withPackages:rows.filter(r=>r.shippingPackages).length});
  if(name==='Message')Object.assign(s,{channels:count(rows,'channel'),directions:count(rows,'direction')});
  summary.tables[name]=s;
 }
 const c=await new LambdaClient({region:'us-west-2'}).send(new GetFunctionConfigurationCommand({FunctionName:'amplify-d4hkkg7dty2du-claudeinvento-Worker11F36D0F-2WWHmekQi8Jm'}));
 const e=c.Environment?.Variables||{};summary.runtime={sendEnabled:e.INQUIRY_CUSTOMER_DELIVERY_ENABLED,lineSendEnabled:e.LINE_OUTBOUND_ENABLED,searchConfigured:!!e.AGENTCORE_GATEWAY_URL,budget:JSON.parse(e.AI_BUDGET_CONFIG_JSON||'{}')};
 fs.mkdirSync('artifacts/customer-ai-20261108',{recursive:true});fs.writeFileSync('artifacts/customer-ai-20261108/current-audit.json',JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
})().catch(e=>{console.error(e.name);process.exitCode=1});
function count(rows,k){return rows.reduce((a,r)=>{const v=String(r[k]??'missing');a[v]=(a[v]||0)+1;return a},{});}
