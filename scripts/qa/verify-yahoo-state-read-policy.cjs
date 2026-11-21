const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {transformSync}=require('esbuild');
const {App,Stack}=require('aws-cdk-lib');
const {Policy,PolicyStatement,Role,ServicePrincipal}=require('aws-cdk-lib/aws-iam');
const {Table,AttributeType}=require('aws-cdk-lib/aws-dynamodb');

// Synthesize the production policy block unchanged, with real cross-stack CDK
// references and synthetic role/table identities. No AWS credentials or calls.
const backendSource=fs.readFileSync('amplify/backend.ts','utf8');
const start='// BEGIN sale Yahoo state read policy (synth-tested from this exact source).';
const end='// END sale Yahoo state read policy.';
assert.equal(backendSource.split(start).length,2);assert.equal(backendSource.split(end).length,2);
const source=backendSource.split(start)[1].split(end)[0];
const outdir=fs.mkdtempSync(path.join(os.tmpdir(),'bello-yahoo-read-synth-'));
const app=new App({outdir}),env={account:'111111111111',region:'us-west-2'};
const saleStack=new Stack(app,'SaleWorker',{env}),yahooStack=new Stack(app,'YahooRuntime',{env});
const saleAutomation={role:new Role(saleStack,'Worker',{assumedBy:new ServicePrincipal('lambda.amazonaws.com')})};
const yahooState=new Table(yahooStack,'OperationState',{partitionKey:{name:'pk',type:AttributeType.STRING}});
let policyStack;const backend={createStack:name=>{assert.equal(name,'SaleYahooStateRead');assert(!policyStack);return policyStack=new Stack(app,name,{env});}};
vm.runInNewContext(transformSync(source,{loader:'ts',format:'cjs'}).code,{backend,saleAutomation,yahooState,Policy,PolicyStatement,Role});
const assembly=app.synth(),template=assembly.getStackArtifact(policyStack.artifactId).template;
const resources=Object.values(template.Resources);assert.equal(resources.length,1);
const policy=resources[0];assert.equal(policy.Type,'AWS::IAM::Policy');
const statements=policy.Properties.PolicyDocument.Statement;assert.equal(statements.length,1);
const statement=statements[0];assert.equal(statement.Effect,'Allow');
assert.deepEqual(statement.Action,['dynamodb:GetItem','dynamodb:ConditionCheckItem']);
// Verify exact symbolic references, rather than permitting any table or role ARN.
assert.deepEqual(statement.Resource,policyStack.resolve(yahooState.tableArn));
const workerArn=policyStack.resolve(saleAutomation.role.roleArn);
assert.equal(typeof workerArn['Fn::ImportValue'],'string');
assert.deepEqual(policy.Properties.Roles,[{'Fn::Select':[1,{'Fn::Split':['/',{'Fn::Select':[5,{'Fn::Split':[':',workerArn]}]}]}]}]);
assert.equal(typeof statement.Resource['Fn::ImportValue'],'string');
assert.equal(JSON.stringify(template).includes('*'),false);
assert.deepEqual(policyStack.dependencies.map(s=>s.stackName).sort(),[saleStack.stackName,yahooStack.stackName].sort());
assert(!saleStack.dependencies.includes(policyStack));assert(!yahooStack.dependencies.includes(policyStack));
assert.equal(Object.values(assembly.getStackArtifact(saleStack.artifactId).template.Resources).filter(r=>r.Type==='AWS::IAM::Policy').length,0);
const evidence={result:'PASS',mode:'local-real-CDK-synth-only',source:'amplify/backend.ts exact marked policy block',actions:statement.Action,resource:statement.Resource,roles:policy.Properties.Roles,policyStackDependencies:policyStack.dependencies.map(s=>s.stackName),sourceStackBackEdge:false,cloudCalls:0,outdir};
if(process.env.BELLO_YAHOO_READ_SYNTH_EVIDENCE)fs.writeFileSync(process.env.BELLO_YAHOO_READ_SYNTH_EVIDENCE,JSON.stringify({evidence,template},null,2)+'\n');
console.log(JSON.stringify(evidence));
