import test from 'node:test';
import assert from 'node:assert/strict';
import { protectedActions } from '../src/eco/store.mjs';
import { requestOwner } from '../src/todo/triage.mjs';

const todo = title => ({ title, category: 'approval' });

test('ordinary production delivery is automated while irreversible changes remain protected', () => {
  assert.equal(requestOwner(todo('production deploy')), 'ai');
  assert.equal(requestOwner(todo('本番へ反映')), 'ai');
  assert.equal(protectedActions.has('production_deploy'), false);
  for (const action of ['production_data', 'destructive_migration', 'major_iam', 'major_s3', 'major_cognito', 'real_listing', 'zaico_production', 'billing']) {
    assert.equal(protectedActions.has(action), true, action);
  }
});
