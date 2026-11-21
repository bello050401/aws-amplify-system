import assert from 'node:assert/strict';
import test from 'node:test';
import { CatalogSelectionController, CatalogSelectionError, selectionDirty, type CatalogSelectionPorts } from '../../lib/inventory/partnerCatalogSelection';
import type { CatalogGrant, PublicCatalogItem } from '../../lib/inventory/partnerCatalog/types';
function fixture() {
  const grant: CatalogGrant = { id: 'one', label: 'One', title: 'catalog', createdAt: '', updatedAt: '', expiresAt: '', disabled: false, path: '/same-existing-link', revision: 0, selectedIds: [] };
  const grants = new Map([['one', grant], ['two', { ...grant, id: 'two' }]]);
  let fail = false, conflict = false, saves = 0;
  const ports: CatalogSelectionPorts = {
    list: async () => [...grants.values()],
    read: async id => ({ grant: grants.get(id)!, candidates: ['a', 'b', 'remote', 'external', 'saved'].map(id => ({ id })) as PublicCatalogItem[], maxSelectedItems: 500 }),
    save: async (id, revision, selectedIds) => { saves++; if (fail) throw Error('offline'); if (conflict || revision !== grants.get(id)!.revision) throw new CatalogSelectionError('conflict', 'changed'); const next = { ...grants.get(id)!, selectedIds, revision: revision + 1 }; grants.set(id, next); return next; },
    link: path => path, copy: async () => {}, open: async () => {},
  };
  return { controller: new CatalogSelectionController(ports), grants, setFail: (value: boolean) => { fail = value; }, setConflict: (value: boolean) => { conflict = value; }, saves: () => saves };
}
test('legacy starts empty; explicit choice persists and keeps the existing path', async () => {
  const f = fixture(), c = f.controller; await c.start(); assert.deepEqual(c.state.draft, []); assert.equal(f.saves(), 0);
  c.toggle('a'); assert.equal(selectionDirty(c.state), true); await c.save(); assert.equal(c.state.data?.grant.path, '/same-existing-link'); assert.equal(c.state.data?.grant.revision, 1);
  await c.choose('one'); assert.deepEqual(c.state.draft, []); c.clear(); await c.save(); assert.deepEqual(f.grants.get('one')?.selectedIds, ['a']); await c.deregister('a'); assert.deepEqual(f.grants.get('one')?.selectedIds, []);
});
test('network failure retains draft; switching links and reload do not overwrite unsaved choices', async () => {
  const f = fixture(), c = f.controller; await c.start(); c.toggle('a'); f.setFail(true); await c.save(); assert.deepEqual(c.state.draft, ['a']); assert.ok(c.state.error);
  await c.choose('two'); assert.deepEqual(c.state.draft, []); c.toggle('b'); await c.choose('one'); assert.deepEqual(c.state.draft, ['a']); await c.start(); assert.deepEqual(c.state.draft, ['a']);
  f.setFail(false); await c.save(); assert.equal(selectionDirty(c.state), false);
});
test('conflict blocks overwrite until explicit fresh read and review; then saves against new revision', async () => {
  const f = fixture(), c = f.controller; await c.start(); c.toggle('a'); f.setConflict(true); await c.save(); assert.equal(c.state.conflict, true); await c.save(); assert.equal(f.saves(), 1);
  f.grants.set('one', { ...f.grants.get('one')!, revision: 4, selectedIds: ['b'] }); f.setConflict(false); await c.choose('one'); assert.deepEqual(c.state.draft, ['a']); assert.equal(c.state.data?.grant.revision, 4); await c.save(); assert.equal(c.state.data?.grant.revision, 5); assert.deepEqual(f.grants.get('one')?.selectedIds, ['b', 'a']);
});
test('registered unavailable items can be individually removed without registering pending choices', async () => {
  const f = fixture(), c = f.controller; f.grants.set('one', { ...f.grants.get('one')!, selectedIds: ['a', 'sold'] }); await c.start(); c.toggle('b'); await c.deregisterUnavailable(); assert.deepEqual(c.state.draft, ['b']); assert.deepEqual(f.grants.get('one')?.selectedIds, ['a']); await c.save(); assert.deepEqual(f.grants.get('one')?.selectedIds, ['a', 'b']);
});
test('a dismissed native share never claims successful copying', async () => {
  const f = fixture(), c = f.controller; c.ports.copy = async () => false; await c.start(); await c.copy(); assert.equal(c.state.notice, '');
});
test('slow reads from a previous grant cannot replace the current grant or its choices', async () => {
  const f = fixture(), c = f.controller; await c.start();
  const read = c.ports.read; let finish!: () => void;
  c.ports.read = async id => { if (id === 'one') await new Promise<void>(resolve => { finish = resolve; }); return read(id); };
  const previous = c.choose('one'); await c.choose('two'); c.toggle('b'); finish(); await previous;
  assert.equal(c.state.id, 'two'); assert.equal(c.state.data?.grant.id, 'two'); assert.deepEqual(c.state.draft, ['b']);
});
test('save is single flight and cannot accept checkbox changes before its result', async () => {
  const f = fixture(), c = f.controller; await c.start(); c.toggle('a');
  const save = c.ports.save; let finish!: () => void;
  c.ports.save = async (...args) => { await new Promise<void>(resolve => { finish = resolve; }); return save(...args); };
  const pending = c.save(); c.toggle('b'); c.clear(); await c.save();
  assert.equal(c.state.saving, true); assert.deepEqual(c.state.draft, ['a']); finish(); await pending;
  assert.equal(f.saves(), 1); assert.deepEqual(f.grants.get('one')?.selectedIds, ['a']);
});
test('reverted clean draft accepts newly saved remote selection on reload', async () => {
  const f = fixture(), c = f.controller; await c.start(); c.toggle('a'); c.toggle('a'); assert.equal(selectionDirty(c.state), false);
  f.grants.set('one', { ...f.grants.get('one')!, selectedIds: ['b'], revision: 2 }); await c.choose('one');
  assert.deepEqual(c.state.draft, []); assert.deepEqual(c.state.data?.grant.selectedIds, ['b']); assert.equal(selectionDirty(c.state), false);
});
test('revocation clears private links and choices and ignores late read and save results', async () => {
  const f = fixture(), c = f.controller; await c.start(); c.toggle('a');
  const save = c.ports.save; let finish!: () => void;
  c.ports.save = async (...args) => { await new Promise<void>(resolve => { finish = resolve; }); return save(...args); };
  const pending = c.save(); c.reset(); finish(); await pending;
  assert.equal(c.state.data, null); assert.deepEqual(c.state.grants, []); assert.deepEqual(c.state.draft, []);
  let finishRead!: () => void; const read = c.ports.read;
  c.ports.read = async id => { await new Promise<void>(resolve => { finishRead = resolve; }); return read(id); };
  const pendingRead = c.choose('one'); c.reset(); finishRead(); await pendingRead; assert.equal(c.state.data, null);
});

test('filtered all-select adds only supplied candidates, preserves other pending choices, and clear never removes registrations', async () => {
  const f = fixture(), c = f.controller; f.grants.set('one', { ...f.grants.get('one')!, selectedIds: ['saved'] }); await c.start();
  c.toggle('a'); c.selectAll(['b', 'saved', 'unknown', 'b']); assert.deepEqual(c.state.draft, ['a', 'b']); assert.equal(f.saves(), 0);
  c.clear(); await c.save(); assert.deepEqual(f.grants.get('one')?.selectedIds, ['saved']); assert.equal(f.saves(), 0);
});
test('500 registration limit rejects whole all-select atomically including existing registrations', async () => {
  const f = fixture(), c = f.controller;
  f.grants.set('one', { ...f.grants.get('one')!, selectedIds: Array.from({ length: 499 }, (_, i) => 'saved-' + i) });
  const read = c.ports.read; c.ports.read = async id => { const data = await read(id); return { ...data, candidates: [...data.candidates, ...data.grant.selectedIds.map(id => ({ id } as PublicCatalogItem))] }; }; await c.start();
  c.selectAll(['a', 'b']); assert.deepEqual(c.state.draft, []); assert.ok(c.state.error.includes('500'));
  c.toggle('a'); c.selectAll(['b']); assert.deepEqual(c.state.draft, ['a']); c.toggle('b'); assert.deepEqual(c.state.draft, ['a']);
  await c.save(); assert.equal(f.grants.get('one')?.selectedIds.length, 500); assert.deepEqual(c.state.draft, []);
});
test('registration failure leaves candidate and pending selection visible; successful retry removes it from candidates', async () => {
  const f = fixture(), c = f.controller; await c.start(); c.toggle('a'); f.setFail(true); await c.save();
  assert.deepEqual(c.state.data?.grant.selectedIds, []); assert.deepEqual(c.state.draft, ['a']);
  f.setFail(false); await c.save(); assert.deepEqual(c.state.data?.grant.selectedIds, ['a']); assert.deepEqual(c.state.draft, []);
  c.toggle('a'); assert.deepEqual(c.state.draft, []); await c.deregister('a'); c.toggle('a'); assert.deepEqual(c.state.draft, ['a']);
});
test('failed and conflicting deregistration preserve saved rows and pending additions until reload', async () => {
  const f = fixture(), c = f.controller; f.grants.set('one', { ...f.grants.get('one')!, selectedIds: ['a'] }); await c.start(); c.toggle('b');
  f.setFail(true); await c.deregister('a'); assert.deepEqual(c.state.data?.grant.selectedIds, ['a']); assert.deepEqual(c.state.draft, ['b']);
  f.setFail(false); f.grants.set('one', { ...f.grants.get('one')!, revision: 3, selectedIds: ['a', 'external'] });
  await c.deregister('a'); assert.equal(c.state.conflict, true); await c.choose('one'); await c.deregister('a');
  assert.deepEqual(f.grants.get('one')?.selectedIds, ['external']); assert.deepEqual(c.state.draft, ['b']);
});
test('reload rebases additions already registered remotely and retains pending choices across grants', async () => {
  const f = fixture(), c = f.controller; await c.start(); c.selectAll(['a', 'b']);
  f.grants.set('one', { ...f.grants.get('one')!, revision: 2, selectedIds: ['a', 'remote'] }); await c.choose('one');
  assert.deepEqual(c.state.draft, ['b']); await c.choose('two'); c.toggle('a'); await c.choose('one'); assert.deepEqual(c.state.draft, ['b']);
  await c.save(); assert.deepEqual(f.grants.get('one')?.selectedIds, ['a', 'remote', 'b']); await c.choose('two'); assert.deepEqual(c.state.draft, ['a']);
});
test('stale pending items can be cleared while keeping registered items', async () => {
  const f = fixture(), c = f.controller; await c.start(); c.selectAll(['a', 'b']);
  const read = c.ports.read; c.ports.read = async id => ({ ...await read(id), candidates: [{ id: 'a' }] as PublicCatalogItem[] });
  await c.choose('one'); c.removeUnavailable(); assert.deepEqual(c.state.draft, ['a']);
});

test('explicit unavailable cleanup retains saved rows and pending additions on failure and conflict', async () => {
  const f = fixture(), c = f.controller; f.grants.set('one', { ...f.grants.get('one')!, selectedIds: ['a', 'sold-1', 'sold-2'] });
  await c.start(); c.toggle('b'); f.setFail(true); await c.deregisterUnavailable();
  assert.deepEqual(c.state.data?.grant.selectedIds, ['a', 'sold-1', 'sold-2']); assert.deepEqual(c.state.draft, ['b']);
  f.setFail(false); f.grants.set('one', { ...f.grants.get('one')!, revision: 2, selectedIds: ['a', 'sold-1', 'sold-2', 'remote'] });
  await c.deregisterUnavailable(); assert.equal(c.state.conflict, true); const count = f.saves(); await c.deregisterUnavailable(); assert.equal(f.saves(), count);
  await c.choose('one'); await c.deregisterUnavailable(); assert.deepEqual(c.state.data?.grant.selectedIds, ['a', 'remote']); assert.deepEqual(c.state.draft, ['b']);
});
