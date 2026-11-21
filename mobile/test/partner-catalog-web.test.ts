import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import React from 'react';
import ts from 'typescript';
import * as selection from '../../lib/inventory/partnerCatalogSelection';
import type { CatalogGrant, PublicCatalogItem } from '../../lib/inventory/partnerCatalog/types';

let controller: selection.CatalogSelectionController, registered = false, query = '';
const webModule = { exports: {} as { PartnerCatalogSelection: (props: unknown) => React.ReactElement } };
const source = ts.transpileModule(readFileSync(new URL('../../app/inventory/(protected)/share/PartnerCatalogSelection.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;
vm.runInNewContext(source, {
  exports: webModule.exports, React,
  require(name: string) {
    if (name === 'react') return { useMemo: () => controller, useState: (initial: unknown) => [typeof initial === 'boolean' ? registered : typeof initial === 'string' ? query : initial, () => {}], useEffect: () => {} };
    if (name === '@/lib/inventory/partnerCatalogSelection') return selection;
    throw Error('Unexpected Web dependency: ' + name);
  },
});
type InspectedProps = { children?: unknown; accessibilityRole?: string; accessibilityLabel?: string; type?: string; className?: string; 'aria-label'?: string; onPress(): void; onClick(): void };
function elements(node: unknown): React.ReactElement<InspectedProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  const element = node as React.ReactElement<InspectedProps>; return [element, ...elements(element.props.children)];
}
function text(node: unknown): string {
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return React.isValidElement(node) ? text((node as React.ReactElement<InspectedProps>).props.children) : '';
}
test('Web candidates use full card labels, scoped all-select, sticky registration, and separate individual deregistration', async () => {
  let grant: CatalogGrant = { id: 'one', label: '取引先', title: '商品', createdAt: '', updatedAt: '', expiresAt: '', disabled: false, path: '/existing', revision: 1, selectedIds: ['chair'] };
  const candidates = [{ id: 'chair', name: 'チェア', managementNumber: 'B001', stageLabel: '補修待ち', imageUrl: null }, { id: 'table', name: 'テーブル', managementNumber: 'B002', stageLabel: '撮影待ち', imageUrl: null }] as PublicCatalogItem[];
  controller = new selection.CatalogSelectionController({ list: async () => [grant], read: async () => ({ grant, candidates, maxSelectedItems: 500 }), save: async (_id, revision, selectedIds) => { grant = { ...grant, revision: revision + 1, selectedIds }; return grant; }, link: path => path, copy: async () => {}, open: async () => {} });
  await controller.start();
  const render = () => elements(webModule.exports.PartnerCatalogSelection({}));
  const button = (label: string) => render().find(e => e.type === 'button' && text(e.props.children) === label)!;
  try {
    query = 'テーブル'; let tree = render();
    assert.equal(tree.filter(e => e.type === 'input' && e.props.type === 'checkbox').length, 1);
    assert.ok(tree.some(e => e.type === 'label' && e.props.className?.includes('min-h-[88px]')));
    button('全選択').props.onClick(); assert.deepEqual(controller.state.draft, ['table']);
    assert.ok(render().some(e => e.props.className?.includes('sticky bottom-0')));
    button('選択した商品を登録（1件）').props.onClick(); await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(grant.selectedIds, ['chair', 'table']); assert.equal(render().filter(e => e.props.type === 'checkbox').length, 0);
    registered = true; query = ''; tree = render();
    assert.equal(tree.filter(e => e.props.type === 'checkbox').length, 0);
    assert.equal(tree.filter(e => e.type === 'button' && text(e.props.children) === '登録解除').length, 2);
    tree.find(e => e.props['aria-label'] === 'チェアの登録を解除')!.props.onClick(); await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(grant.selectedIds, ['table']);
  } finally { registered = false; query = ''; }
});
