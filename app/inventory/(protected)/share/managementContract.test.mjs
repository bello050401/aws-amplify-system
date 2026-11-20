import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as crypto from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const sdk = require('@aws-sdk/lib-dynamodb');
function load(path, imports = {}) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports, Buffer, Date, Set, Map, URL, Error, require: name => {
    assert.ok(Object.hasOwn(imports, name), name); return imports[name];
  } });
  return exports;
}
const { catalogMutation } = load('./catalogMutation.ts');
const { createCatalogGrantStore } = load('../../../../lib/inventory/partnerCatalog/grants.ts', {
  'server-only': {}, 'node:crypto': crypto, '@aws-sdk/lib-dynamodb': sdk,
  './policy': { validToken: value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) },
});

test('UI create, renew and disable bodies satisfy the actual strict backend; disable revokes access', async () => {
  const rows = new Map();
  const key = row => `${row.scope}/${row.id}`;
  const db = { async send(command) {
    const input = command.input;
    if (command instanceof sdk.QueryCommand) return { Items: [...rows.values()].filter(row => row.id.startsWith('partner-catalog:grant:')) };
    if (command instanceof sdk.GetCommand) return { Item: rows.get(key(input.Key)) };
    if (command instanceof sdk.TransactWriteCommand) {
      for (const { Put } of input.TransactItems) rows.set(key(Put.Item), Put.Item);
      return {};
    }
    throw new Error('Unexpected database operation');
  } };
  const store = createCatalogGrantStore(db, 'private-test-only');
  const create = await store.manage(catalogMutation('create', '取引先A'), 'admin');
  const token = create.path.split('/').at(-1);
  assert.ok(await store.authorize(token));
  const renew = await store.manage(catalogMutation('renew', '', create.id), 'admin');
  const renewedToken = renew.path.split('/').at(-1);
  assert.equal(await store.authorize(token), null);
  assert.ok(await store.authorize(renewedToken));
  const body = catalogMutation('disable', '', create.id);
  assert.equal(Object.hasOwn(body, 'expiresInDays'), false);
  const disabled = await store.manage(body, 'admin');
  assert.equal(disabled.disabled, true);
  assert.equal(await store.authorize(renewedToken), null);
  await assert.rejects(store.manage({ ...body, expiresInDays: 90 }, 'admin'), error => error.status === 400);
});
