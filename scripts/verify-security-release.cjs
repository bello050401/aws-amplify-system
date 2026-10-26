/** Exercise the actual release gate in child processes; no AWS calls or real approvals. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bello-security-release-'));
const file=path.join(dir,'evidence.json'),gate=path.join(__dirname,'check-security-release.cjs');
const checks=['productionUsersPreserved','legacyGroupsPreserved','allBusinessRoutesGated','appSyncDirectAccessDenied','apiKeyPrivateDataDenied','identityPoolDirectAccessDenied','s3ExistingUrlExpiryBounded','photoStationMachineAuthVerified','oauthCallbacksVerified','backgroundWorkersVerified','adminRecoveryRehearsed','rollbackRehearsed','realIPhonePasskeyPassed','realWindowsHelloPassed','sessionReopenPassed','revocationOnRealBusinessApiPassed','businessRegressionPassed','auditAlertRecipientVerified','trustedClientIpVerified'];
const env={...process.env,AWS_APP_ID:'d4hkkg7dty2du',AWS_BRANCH:'claude/inventory-management-system-5vbvc7',AWS_COMMIT_ID:'synthetic-release-only',BELLO_DEVICE_SECURITY:'enforced',BELLO_PHOTO_DEVICE_APPROVAL:'',BELLO_SECURITY_RELEASE_EVIDENCE:file};
const base=()=>({commit:env.AWS_COMMIT_ID,targetOrigin:'https://claude-inventory-management-system-5vbvc7.d4hkkg7dty2du.amplifyapp.com',approvedBy:'synthetic-test-only',approvedAt:new Date().toISOString(),checks:Object.fromEntries(checks.map(k=>[k,{passed:true,evidence:'synthetic unit fixture; not acceptance evidence'}]))});
const run=(record,extra={})=>{if(record)fs.writeFileSync(file,JSON.stringify(record));else if(fs.existsSync(file))fs.unlinkSync(file);return cp.spawnSync(process.execPath,[gate],{env:{...env,...extra},encoding:'utf8'});};
let passed=0;function test(name,fn){fn();passed++;console.log('PASS '+name);}
function denied(record,extra){const r=run(record,extra);assert.notEqual(r.status,0);assert(r.stderr.includes('SECURITY_CUTOVER_BLOCKED'));}
try{
 test('Production enforcement without evidence is blocked',()=>denied(null));
 test('Photo-device enforcement also requires evidence',()=>denied(null,{BELLO_DEVICE_SECURITY:'legacy',BELLO_PHOTO_DEVICE_APPROVAL:'enforced'}));
 test('Evidence is bound to exact commit and origin',()=>{for(const patch of [{commit:'another'},{targetOrigin:'https://another.example.invalid'}])denied({...base(),...patch});});
 test('Expired, future or unapproved evidence is rejected',()=>{for(const patch of [{approvedAt:new Date(Date.now()-86401000).toISOString()},{approvedAt:new Date(Date.now()+60000).toISOString()},{approvedAt:'invalid'},{approvedBy:''}])denied({...base(),...patch});});
 test('Every one of the nineteen checks is required',()=>{for(const key of checks){const r=base();delete r.checks[key];denied(r);}});
 test('False, string booleans and empty evidence cannot pass',()=>{for(const value of [{passed:false,evidence:'exists'},{passed:'true',evidence:'exists'},{passed:true,evidence:'  '}]){const r=base();r.checks.realIPhonePasskeyPassed=value;denied(r);}});
 test('Complete synthetic record exercises success branch only in unit process',()=>assert.equal(run(base()).status,0));
 test('Legacy production deployment does not force security migration',()=>assert.equal(run(null,{BELLO_DEVICE_SECURITY:'legacy'}).status,0));
 test('Isolated staging does not impersonate a production cutover',()=>assert.equal(run(null,{AWS_BRANCH:'codex/security-20261026'}).status,0));
 console.log(JSON.stringify({passed,failed:0,productionChanged:false,realApproval:false}));
}finally{
 // Delete only the exact temporary fixture and now-empty directory we created.
 if(fs.existsSync(file))fs.unlinkSync(file);fs.rmdirSync(dir);
}
