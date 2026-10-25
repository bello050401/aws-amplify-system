// Disposable, non-production UI fixture. Never prints credentials or sends invitations.
const fs=require('node:fs'),path=require('node:path'),{randomBytes}=require('node:crypto'),{execFileSync}=require('node:child_process');
const out=JSON.parse(fs.readFileSync('cdk.out/security/pilot-outputs.json','utf8')).BelloSecurityPilot20261026;
const dir=path.join(process.env.LOCALAPPDATA,'BELLO','security-pilot'),file=path.join(dir,'ui-fixture.json');
fs.mkdirSync(dir,{recursive:true});
execFileSync('icacls',[dir,'/inheritance:r','/grant:r',process.env.USERDOMAIN+'\\'+process.env.USERNAME+':(OI)(CI)F','SYSTEM:(OI)(CI)F'],{stdio:'pipe'});
function aws(op,data,query){const p=path.join(dir,'input-'+randomBytes(12).toString('hex')+'.json');try{fs.writeFileSync(p,JSON.stringify(data));const args=['cognito-idp',op,'--profile','Bello','--region','us-west-2','--cli-input-json','file://'+p,'--output','json'];if(query)args.push('--query',query);return JSON.parse(execFileSync('C:/Program Files/Amazon/AWSCLIV2/aws.exe',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']})||'{}');}finally{fs.unlinkSync(p);}}
if(aws('describe-user-pool',{UserPoolId:out.PoolId},'UserPool.Name')!=='bello-security-pilot-20261026')throw Error('NOT_PILOT');
if(process.argv[2]==='cleanup'){
  const f=JSON.parse(fs.readFileSync(file));if(f.pool!==out.PoolId||!f.username.startsWith('qa-ui-'))throw Error('INVALID_FIXTURE');
  aws('admin-disable-user',{UserPoolId:f.pool,Username:f.username});fs.unlinkSync(file);console.log('UI fixture disabled; temporary credentials removed.');
}else{
  if(fs.existsSync(file))throw Error('Fixture already exists; clean it first.');
  const username='qa-ui-'+Date.now()+'@bello.invalid',password='Ui9!'+randomBytes(24).toString('base64url');
  aws('admin-create-user',{UserPoolId:out.PoolId,Username:username,MessageAction:'SUPPRESS',UserAttributes:[{Name:'email',Value:username},{Name:'email_verified',Value:'true'}]});
  aws('admin-set-user-password',{UserPoolId:out.PoolId,Username:username,Password:password,Permanent:true});
  aws('admin-add-user-to-group',{UserPoolId:out.PoolId,Username:username,GroupName:'EDITOR'});
  fs.writeFileSync(file,JSON.stringify({username,password,pool:out.PoolId}));console.log('Disposable UI fixture ready. No business data access.');
}
