/** Never activate a production auth migration merely by setting an env flag. */
const fs=require('node:fs');
if(process.env.BELLO_DEVICE_SECURITY!=='enforced'&&process.env.BELLO_PHOTO_DEVICE_APPROVAL!=='enforced')process.exit(0);
const isProduction=process.env.AWS_APP_ID==='d4hkkg7dty2du'&&process.env.AWS_BRANCH==='claude/inventory-management-system-5vbvc7';
if(!isProduction){console.log('Security enabled outside production; isolated regression checks still required.');process.exit(0);}
const required=['productionUsersPreserved','legacyGroupsPreserved','allBusinessRoutesGated','appSyncDirectAccessDenied','apiKeyPrivateDataDenied','identityPoolDirectAccessDenied','s3ExistingUrlExpiryBounded','photoStationMachineAuthVerified','oauthCallbacksVerified','backgroundWorkersVerified','adminRecoveryRehearsed','rollbackRehearsed','realIPhonePasskeyPassed','realWindowsHelloPassed','sessionReopenPassed','revocationOnRealBusinessApiPassed','businessRegressionPassed','auditAlertRecipientVerified','trustedClientIpVerified'];
let record;try{record=JSON.parse(fs.readFileSync(process.env.BELLO_SECURITY_RELEASE_EVIDENCE||'', 'utf8'));}catch{throw Error('SECURITY_CUTOVER_BLOCKED: validation evidence is required before changing production authentication.');}
if(record.commit!==process.env.AWS_COMMIT_ID||record.targetOrigin!=='https://claude-inventory-management-system-5vbvc7.d4hkkg7dty2du.amplifyapp.com'||!record.approvedBy||!Number.isFinite(Date.parse(record.approvedAt))||Date.now()-Date.parse(record.approvedAt)>86400000||Date.parse(record.approvedAt)>Date.now())throw Error('SECURITY_CUTOVER_BLOCKED: evidence must be approved for this exact release within 24 hours.');
const missing=required.filter(k=>record.checks?.[k]?.passed!==true||!record.checks[k].evidence?.trim());
if(missing.length)throw Error('SECURITY_CUTOVER_BLOCKED: '+missing.join(','));
console.log('Security release evidence accepted for this commit.');
