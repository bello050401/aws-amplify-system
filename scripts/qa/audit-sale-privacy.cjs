// Read-only inventory. Never writes customer values to disk or stdout.
const fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {DynamoDBClient,ListTablesCommand,DescribeTableCommand,DescribeContinuousBackupsCommand,ListBackupsCommand}=require('@aws-sdk/client-dynamodb');
const {DynamoDBDocumentClient,ScanCommand,GetCommand}=require('@aws-sdk/lib-dynamodb');
const outputs=require('../../amplify_outputs.json');
const dir=path.resolve('artifacts/sale-automation-20261108');fs.mkdirSync(dir,{recursive:true});
const client=new DynamoDBClient({region:'us-west-2'}),db=DynamoDBDocumentClient.from(client);
const aws=(args)=>JSON.parse(execFileSync('aws',[...args,'--output','json'],{encoding:'utf8',maxBuffer:20*1024*1024,windowsHide:true}));
const stats=(rows,key)=>rows.reduce((a,r)=>(a[String(r[key]??'none')]=(a[String(r[key]??'none')]||0)+1,a),{});
async function scan(table,project){let cursor,rows=[];do{const r=await db.send(new ScanCommand({TableName:table,ExclusiveStartKey:cursor,...(project?{ProjectionExpression:project}:{}),Limit:100}));rows.push(...r.Items||[]);cursor=r.LastEvaluatedKey;}while(cursor);return rows;}
(async()=>{
 const tables=[];let cursor;do{const r=await client.send(new ListTablesCommand({ExclusiveStartTableName:cursor}));tables.push(...r.TableNames);cursor=r.LastEvaluatedTableName;}while(cursor);
 const candidatesTable=outputs.custom.saleCandidates.tableName;
 const candidates=await scan(candidatesTable);
 const sales=candidates.filter(x=>/^[a-f0-9]{64}$/.test(x.id));
 const imports=candidates.filter(x=>['IMPORT_STATUS','BASE_IMPORT_STATUS','YAHOO_PAYMENT_CURSOR'].includes(x.id));
 const ec=await scan('BelloEconveniWorkflow');
 const relevant=tables.filter(n=>/^(Conversation-|Message-|ReplyDraft-|MercariOrderContext-|NotificationDelivery-|Inventory-|InventoryHistory-)|(?:Addressees|InquiryRuntime|PurchaseNotifications|ProcurementImport)/.test(n));
 const metadata=[];
 for(const name of relevant){const {Table:t}=await client.send(new DescribeTableCommand({TableName:name}));if(!t.ItemCount&&!name.includes('j6up24')&&!name.includes('d4hkkg'))continue;
  const b=await client.send(new DescribeContinuousBackupsCommand({TableName:name}));
  metadata.push({name,count:t.ItemCount,bytes:t.TableSizeBytes,pitr:b.ContinuousBackupsDescription?.PointInTimeRecoveryDescription});}
 const piiTables=metadata.filter(x=>/^(Conversation-|Message-|ReplyDraft-|MercariOrderContext-)|Addressees|InquiryRuntime/.test(x.name));
 const fields=[];
 for(const {name,count} of piiTables){if(!count)continue;const rows=await scan(name);const populated={};for(const row of rows)for(const [k,v] of Object.entries(row))if(v!=null&&v!==''&&/customer|buyer|recipient|address|email|phone|body|text|context|draft|name|payload|content|message|attachment/i.test(k))populated[k]=(populated[k]||0)+1;fields.push({table:name,rows:rows.length,populatedFields:populated,statuses:stats(rows,'status'),workflowStates:stats(rows,'workflowStatus')});}
 const functions=aws(['lambda','list-functions']).Functions.filter(f=>f.FunctionName.includes('d4hkkg')&&/purchase|yahoopayment|Worker11F/.test(f.FunctionName)).map(f=>({name:f.FunctionName,modified:f.LastModified,timeout:f.Timeout,environmentKeys:Object.keys(f.Environment?.Variables||{})}));
 const rules=aws(['events','list-rules']).Rules.filter(r=>/purchase|yahoo|inquiry/i.test(r.Name)).map(r=>({name:r.Name,schedule:r.ScheduleExpression,state:r.State}));
 const buckets=aws(['s3api','list-buckets']).Buckets.map(b=>b.Name).filter(n=>/inventory|inquiry|photo|auditarchive/i.test(n));
 const logs=aws(['logs','describe-log-groups']).logGroups.filter(g=>/d4hkkg|bello/i.test(g.logGroupName)).map(g=>({name:g.logGroupName,retention:g.retentionInDays??null,bytes:g.storedBytes}));
 const backups=await client.send(new ListBackupsCommand({Limit:100}));
 const ecPlans=ec.filter(r=>r.pk.startsWith('SALE_EC#'));
 const report={at:new Date().toISOString(),region:'us-west-2',tableCount:tables.length,candidates:{table:candidatesTable,count:sales.length,states:stats(sales,'state'),channels:stats(sales,'channel'),yahooPaymentStates:stats(sales,'yahooPaymentState'),statuses:imports,customerFields:sales.flatMap(x=>Object.keys(x).filter(k=>/buyer|customer|address|email|phone/i.test(k))).filter((x,i,a)=>a.indexOf(x)===i)},ec:{plans:ecPlans.length,states:stats(ecPlans,'state'),rowStates:stats(ecPlans.flatMap(p=>p.rows||[]),'state'),manualLinks:ec.filter(r=>r.pk.startsWith('ECONVENI#MANUAL_LINK#')).length},functions,rules,tables:metadata,fields,buckets,logs,backups:backups.BackupSummaries?.map(b=>({table:b.TableName,created:b.BackupCreationDate,status:b.BackupStatus,type:b.BackupType})),backupsMore:!!backups.LastEvaluatedBackupArn};
 fs.writeFileSync(path.join(dir,'audit.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({at:report.at,candidates:report.candidates,ec:report.ec,functions,rules,customerStores:fields.map(x=>({table:x.table,rows:x.rows,fields:x.populatedFields,statuses:x.statuses})),scopedTableCount:metadata.length,bucketCount:buckets.length,logGroupCount:logs.length,backupsMore:report.backupsMore},null,2));
})().catch(e=>{console.error(e.name);process.exitCode=1;});
