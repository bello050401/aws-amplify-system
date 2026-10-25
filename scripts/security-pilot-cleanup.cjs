// Close only the disposable accounts in this named, isolated security pilot.
const fs=require('node:fs'),{execFileSync}=require('node:child_process');
const out=JSON.parse(fs.readFileSync('cdk.out/security/pilot-outputs.json','utf8')).BelloSecurityPilot20261026;
function aws(service,operation,args){return JSON.parse(execFileSync('C:/Program Files/Amazon/AWSCLIV2/aws.exe',[service,operation,...args,'--profile','Bello','--region','us-west-2','--output','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']})||'{}');}
if(aws('cognito-idp','describe-user-pool',['--user-pool-id',out.PoolId]).UserPool.Name!=='bello-security-pilot-20261026')throw Error('NOT_PILOT');
let closed=0,cursor;
do{
 const page=aws('dynamodb','query',['--table-name',out.Table,'--index-name','ByKind','--key-condition-expression','#k = :k','--expression-attribute-names',JSON.stringify({'#k':'kind'}),'--expression-attribute-values',JSON.stringify({':k':{S:'user'}}),...(cursor?['--exclusive-start-key',JSON.stringify(cursor)]:[])]);
 for(const row of page.Items??[]){
  const username=row.username?.S;
  if(!/^qa-(?:admin|editor|ui)-\d+@bello\.invalid$/.test(username??''))continue;
  aws('cognito-idp','admin-disable-user',['--user-pool-id',out.PoolId,'--username',username]);
  aws('dynamodb','update-item',['--table-name',out.Table,'--key',JSON.stringify({id:row.id}),'--update-expression','SET enabled = :disabled ADD generation :one, #v :one','--condition-expression','#v = :version','--expression-attribute-names',JSON.stringify({'#v':'version'}),'--expression-attribute-values',JSON.stringify({':disabled':{BOOL:false},':one':{N:'1'},':version':row.version})]);
  closed++;
 }
 cursor=page.LastEvaluatedKey;
}while(cursor);
fs.writeFileSync('artifacts/security-20261026/fixture-cleanup.json',JSON.stringify({at:new Date().toISOString(),closed,providerDisabled:true,serverSessionsInvalidated:true,productionChanged:false},null,2));
console.log(`Disabled ${closed} disposable accounts and invalidated their server sessions.`);
