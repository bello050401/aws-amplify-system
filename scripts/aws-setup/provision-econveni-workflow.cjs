// Dedicated metadata/queue only. No inventory, credential or existing role policy is replaced.
const {execFileSync}=require('node:child_process');
const {writeFileSync,mkdtempSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const aws=process.platform==='win32'?'C:/Program Files/Amazon/AWSCLIV2/aws.exe':'aws';
const dir=mkdtempSync(join(tmpdir(),'bello-econveni-provision-'));
function call(service,operation,input){
  const file=join(dir,operation+'.json');writeFileSync(file,JSON.stringify(input));
  return JSON.parse(execFileSync(aws,[service,operation,'--cli-input-json','file://'+file.replaceAll('\\','/'),'--profile','Bello','--region','us-west-2','--output','json','--cli-connect-timeout','10','--cli-read-timeout','30'],{encoding:'utf8',stdio:['ignore','pipe','pipe']})||'{}');
}
const account=call('sts','get-caller-identity',{}).Account;if(account!=='203918843421')throw Error('Unexpected AWS account');
const TableName='BelloEconveniWorkflow';let table;
try{table=call('dynamodb','describe-table',{TableName}).Table;}catch(e){
  if(!String(e.stderr).includes('ResourceNotFoundException'))throw Error('Table lookup failed');
  table=call('dynamodb','create-table',{TableName,KeySchema:[{AttributeName:'pk',KeyType:'HASH'}],AttributeDefinitions:[{AttributeName:'pk',AttributeType:'S'}],BillingMode:'PAY_PER_REQUEST',SSESpecification:{Enabled:true},Tags:[{Key:'Application',Value:'BELLO'},{Key:'Purpose',Value:'econveni-workflow'}]}).TableDescription;
}
if(table.KeySchema?.length!==1||table.KeySchema[0].AttributeName!=='pk'||!table.TableArn?.startsWith('arn:aws:dynamodb:us-west-2:203918843421:table/'))throw Error('Unexpected table');
call('iam','put-role-policy',{RoleName:'BelloAmplifyStagingComputeRole',PolicyName:'BelloEconveniWorkflow',PolicyDocument:JSON.stringify({Version:'2012-10-17',Statement:[{Effect:'Allow',Action:['dynamodb:GetItem','dynamodb:PutItem','dynamodb:UpdateItem','dynamodb:ConditionCheckItem','dynamodb:Scan'],Resource:table.TableArn}]})});
console.log(JSON.stringify({table:TableName,status:table.TableStatus,role:'BelloAmplifyStagingComputeRole'}));
