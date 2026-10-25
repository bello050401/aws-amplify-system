import assert from 'node:assert/strict';
import { defineBackend } from '@aws-amplify/backend';
import { Template } from 'aws-cdk-lib/assertions';
import { Stack } from 'aws-cdk-lib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { auth } from '../amplify/auth/resource';
import { storage } from '../amplify/storage/resource';

// Synthesize ONLY auth/storage locally. No AWS calls or deployment and no
// business functions, customer data, mail or EC integrations are instantiated.
process.env.CDK_CONTEXT_JSON = JSON.stringify({
  'amplify-backend-namespace': 'security-storage-check',
  'amplify-backend-name': 'security-storage-check',
  'amplify-backend-type': 'sandbox',
});
const backend = defineBackend({ auth, storage });
const authTemplate = Template.fromStack(Stack.of(backend.auth.resources.userPool)).toJSON();
const storageTemplate = Template.fromStack(Stack.of(backend.storage.resources.bucket)).toJSON();
mkdirSync('artifacts/security-20261026/storage-synth', { recursive: true });
writeFileSync('artifacts/security-20261026/storage-synth/auth.json', JSON.stringify(authTemplate, null, 2));
writeFileSync('artifacts/security-20261026/storage-synth/storage.json', JSON.stringify(storageTemplate, null, 2));
const groups = Object.values(authTemplate.Resources).filter((r:any)=>r.Type==='AWS::Cognito::UserPoolGroup') as any[];
assert.equal(groups.length, 6);
const precedence = Object.fromEntries(groups.map(g=>[g.Properties.GroupName, g.Properties.Precedence]));
for (const name of ['ADMIN','EDITOR','VIEWER']) assert(precedence[name]<precedence.Admins);
const policies = Object.values(storageTemplate.Resources).filter((r:any)=>r.Type==='AWS::IAM::Policy') as any[];
assert.equal(policies.length, 3, 'only ADMIN, EDITOR and VIEWER receive storage policies');
const statements = (name:string) => policies.filter(p=>JSON.stringify(p.Properties.Roles).includes('Auth'+name+'GroupRole'))
  .flatMap(p=>p.Properties.PolicyDocument.Statement);
for (const name of ['Admins','MOBILE_HIDE_EC','MOBILE_HIDE_SALES']) assert.equal(statements(name).length, 0);
const names = Object.keys(precedence);
let combinations = 0;
for (let mask=0;mask<(1<<names.length);mask++) {
  const memberships = names.filter((_,i)=>Boolean(mask&(1<<i)));
  const preferred = [...memberships].sort((a,b)=>precedence[a]-precedence[b])[0];
  const effective = preferred ? statements(preferred) : [];
  for (const prefix of ['inventory','knowledge']) for (const action of ['s3:GetObject','s3:PutObject','s3:DeleteObject']) {
    const actual = effective.some(s=>s.Effect==='Allow' && [s.Action].flat().includes(action) && JSON.stringify(s.Resource).includes('/'+prefix+'/*'));
    const expected = prefix==='knowledge' ? memberships.includes('ADMIN') :
      memberships.includes('ADMIN') || memberships.includes('EDITOR') || (action==='s3:GetObject' && memberships.includes('VIEWER'));
    assert.equal(actual, expected, `${memberships.join('+')||'none'} ${prefix} ${action}`);
  }
  combinations++;
}
const result = { synthesized: true, roleCombinationsPassed: combinations, groups: precedence,
  productionChanged: false, deployedIamTest: false };
writeFileSync('artifacts/security-20261026/storage-role-results.json', JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
