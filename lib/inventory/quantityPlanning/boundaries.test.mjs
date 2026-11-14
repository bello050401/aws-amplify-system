import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function load(path, imports, globals = {}) {
  const exports = {};
  const input = readFileSync(new URL(path, import.meta.url), 'utf8');
  const code = ts.transpileModule(input, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports, require: name => {
    assert.ok(Object.hasOwn(imports, name), name);
    return imports[name];
  }, ...globals });
  return exports;
}

test('server rechecks signed owner and role before allowing the service to use its IAM reader', async () => {
  let access;
  let signature;
  const roles = [];
  const server = load('./server.ts', {
    'server-only': {},
    '@/lib/amplify/requireInventoryUser': {
      getVerifiedInventoryAccess: async () => access,
      canEditInventory: role => { roles.push(role); return role === 'EDITOR' || role === 'ADMIN'; },
    },
    '../categoryPersistence': {},
    '../mutationSession': { inventoryVerifiedReadSession: async () => signature },
    './store': { createQuantityPlanningStore: () => ({}) },
    './service': { createQuantityPlanningService: deps => deps },
  });
  access = { kind: 'authorized', owner: null, role: 'ADMIN' };
  assert.equal(await server.quantityPlanningServer().authorize(), null);
  access = { kind: 'authorized', owner: 'owner-1', role: 'VIEWER' };
  assert.equal(await server.quantityPlanningServer().authorize(), null);
  signature = { owner: 'owner-1', role: 'EDITOR' };
  assert.equal(await server.quantityPlanningServer().authorize(), null);
  signature.role = 'VIEWER';
  assert.equal(await server.quantityPlanningServer('owner-2').authorize(), null);
  const deps = server.quantityPlanningServer('owner-1');
  assert.equal((await deps.authorize())?.owner, 'owner-1');
  assert.equal(deps.canEdit('VIEWER'), false);
  assert.deepEqual(roles, ['VIEWER']);
});

test('mobile route binds owner, refuses foreign POSTs and lets the native enable flag gate saving', async () => {
  const calls = [];
  const settings = { BELLO_MOBILE_WRITES_ENABLED: 'false' };
  let session = { ok: true, owner: 'owner-1', role: 'EDITOR' };
  const route = load('../../../app/api/mobile/inventory/[id]/quantity-planning/route.ts', {
    'next/server': { NextResponse: { json: (data, init) => Response.json(data, init) } },
    '@/lib/mobile/session': { getMobileSession: async () => session },
    '@/lib/inventory/analysis/normalize': { fields: value => value && typeof value === 'object' && !Array.isArray(value) ? value : null },
    '@/lib/inventory/quantityPlanning/settings': { hasKeys: (value, keys) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) },
    '@/lib/inventory/quantityPlanning/server': { quantityPlanningServer: owner => ({
      read: async id => { calls.push(['read', owner, id]); return { status: 'ok', canEdit: true }; },
      calculate: async (id, raw) => { calls.push(['calculate', owner, id, raw]); return { status: 'ok', token: 'opaque' }; },
      save: async (id, raw, allowed) => {
        calls.push(['save', owner, id, raw, allowed]);
        return allowed ? { status: 'ok', canEdit: true } : { status: 'forbidden', message: 'disabled' };
      },
    }) },
  }, { process: { env: settings }, Buffer, TextDecoder, URL });
  const url = 'https://local.invalid/api/mobile/inventory/unit-test/quantity-planning';
  const context = { params: Promise.resolve({ id: 'test-inventory' }) };
  const makePost = (data, headers = {}) => new Request(url, {
    method: 'POST', headers: { 'x-bello-mobile': '1', 'content-type': 'application/json', ...headers }, body: JSON.stringify(data),
  });
  const state = await route.GET(new Request(url), context);
  assert.deepEqual(await state.json(), { owner: 'owner-1', result: { status: 'ok', canEdit: false } });
  assert.equal(state.headers.get('cache-control'), 'private, no-store');
  const calcRequest = { action: 'calculate', conditions: {} };
  assert.equal((await route.POST(makePost(calcRequest, { origin: 'https://other.invalid' }), context)).status, 403);
  assert.equal((await route.POST(makePost(calcRequest, { 'sec-fetch-site': 'cross-site' }), context)).status, 403);
  assert.equal((await route.POST(makePost({ ...calcRequest, conditions: 'x'.repeat(4100) }), context)).status, 422);
  assert.equal(calls.length, 1);
  const calculation = await route.POST(makePost(calcRequest), context);
  assert.deepEqual(await calculation.json(), { owner: 'owner-1', result: { status: 'ok', token: null } });
  const saveRequest = { action: 'save', conditions: {}, token: 'opaque', operationId: 'stable-id' };
  const disabled = await route.POST(makePost(saveRequest), context);
  assert.equal(disabled.status, 403);
  assert.equal(calls.at(-1)[4], false);
  settings.BELLO_MOBILE_WRITES_ENABLED = 'true';
  const enabled = await route.POST(makePost(saveRequest), context);
  assert.equal(enabled.status, 200);
  assert.equal(calls.at(-1)[4], true);
  session = { ok: false, status: 401, error: 'SIGN_IN_REQUIRED' };
  const signedOut = await route.GET(new Request(url), context);
  assert.equal(signedOut.status, 401);
  assert.equal(calls.length, 4);
});
