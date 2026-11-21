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
    read: async id => ({ grant: grants.get(id)!, candidates: [{ id: 'a' }, { id: 'b' }] as PublicCatalogItem[], maxSelectedItems: 500 }),
    save: async (id, revision, selectedIds) => { saves++; if (fail) throw Error('offline'); if (conflict || revision !== grants.get(id)!.revision) throw new CatalogSelectionError('conflict', 'changed'); const next = { ...grants.get(id)!, selectedIds, revision: revision + 1 }; grants.set(id, next); return next; },
    link: path => path, copy: async () => {}, open: async () => {},
  };
  return { controller: new CatalogSelectionController(ports), grants, setFail: (value: boolean) => { fail = value; }, setConflict: (value: boolean) => { conflict = value; }, saves: () => saves };
}
test('legacy starts empty; explicit choice persists and keeps the existing path', async () => {
  const f = fixture(), c = f.controller; await c.start(); assert.deepEqual(c.state.draft, []); assert.equal(f.saves(), 0);
  c.toggle('a'); assert.equal(selectionDirty(c.state), true); await c.save(); assert.equal(c.state.data?.grant.path, '/same-existing-link'); assert.equal(c.state.data?.grant.revision, 1);
  await c.choose('one'); assert.deepEqual(c.state.draft, ['a']); c.clear(); await c.save(); assert.deepEqual(f.grants.get('one')?.selectedIds, []);
});
test('network failure retains draft; switching links and reload do not overwrite unsaved choices', async () => {
  const f = fixture(), c = f.controller; await c.start(); c.toggle('a'); f.setFail(true); await c.save(); assert.deepEqual(c.state.draft, ['a']); assert.ok(c.state.error);
  await c.choose('two'); assert.deepEqual(c.state.draft, []); c.toggle('b'); await c.choose('one'); assert.deepEqual(c.state.draft, ['a']); await c.start(); assert.deepEqual(c.state.draft, ['a']);
  f.setFail(false); await c.save(); assert.equal(selectionDirty(c.state), false);
});
test('conflict blocks overwrite until explicit fresh read and review; then saves against new revision', async () => {
  const f = fixture(), c = f.controller; await c.start(); c.toggle('a'); f.setConflict(true); await c.save(); assert.equal(c.state.conflict, true); await c.save(); assert.equal(f.saves(), 1);
  f.grants.set('one', { ...f.grants.get('one')!, revision: 4, selectedIds: ['b'] }); f.setConflict(false); await c.choose('one'); assert.deepEqual(c.state.draft, ['a']); assert.equal(c.state.data?.grant.revision, 4); await c.save(); assert.equal(c.state.data?.grant.revision, 5);
});
test('newly unavailable selected items can be removed without discarding eligible choices', async () => {
  const f = fixture(), c = f.controller; f.grants.set('one', { ...f.grants.get('one')!, selectedIds: ['a', 'sold'] }); await c.start(); c.removeUnavailable(); assert.deepEqual(c.state.draft, ['a']); await c.save(); assert.deepEqual(f.grants.get('one')?.selectedIds, ['a']);
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
  assert.deepEqual(c.state.draft, ['b']); assert.equal(selectionDirty(c.state), false);
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
