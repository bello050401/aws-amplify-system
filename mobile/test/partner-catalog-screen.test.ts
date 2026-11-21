import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import React from 'react';
import ts from 'typescript';
import * as selection from '../../lib/inventory/partnerCatalogSelection';
import type { CatalogGrant, PublicCatalogItem } from '../../lib/inventory/partnerCatalog/types';

// Execute the real screen at the native component boundary. Host components remain
// identifiable React elements, so empty strings cannot be erased by a DOM renderer.
const source = ts.transpileModule(readFileSync(new URL('../src/ui/PartnerCatalogScreen.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
}).outputText;
let registeredView = false, searchQuery = '';
const screenModule = { exports: {} as { PartnerCatalogScreen: (props: unknown) => React.ReactElement } };
vm.runInNewContext(source, {
  exports: screenModule.exports,
  require(name: string) {
    if (name === 'react') return { __esModule: true, default: React, useMemo: (factory: () => unknown) => factory(), useState: (initial: unknown) => [typeof initial === 'boolean' ? registeredView : typeof initial === 'string' ? searchQuery : initial, () => {}], useEffect: () => {} };
    if (name === 'react-native') return { Image: 'Image', Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View', StyleSheet: { create: (styles: unknown) => styles } };
    if (name === '../../../lib/inventory/partnerCatalogSelection') return selection;
    throw Error(`Unexpected screen dependency: ${name}`);
  },
});

const grant: CatalogGrant = { id: 'one', label: '取引先', title: '商品', createdAt: '', updatedAt: '', expiresAt: '2099-01-01T00:00:00Z', disabled: false, path: '/share/inventory/existing', revision: 1, selectedIds: [] };
const item: PublicCatalogItem = { id: 'chair', name: 'オーク ダイニングチェア', managementNumber: 'B-001', quantity: 1, dimensions: { width: null, depth: null, height: null }, stage: 'repair', stageLabel: '補修待ち', imageUrl: null, images: [] };
const ports: selection.CatalogSelectionPorts = { list: async () => [], read: async () => ({ grant, candidates: [], maxSelectedItems: 500 }), save: async () => grant, link: path => 'https://example.invalid' + path, copy: async () => {}, open: async () => {} };

function inspect(node: unknown, parentHost: string | null, text: string[]): void {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (Array.isArray(node)) { for (const child of node) inspect(child, parentHost, text); return; }
  if (typeof node === 'string' || typeof node === 'number') {
    assert.equal(parentHost, 'Text', `Raw text ${JSON.stringify(node)} cannot be a child of ${parentHost}`);
    text.push(String(node)); return;
  }
  assert.ok(React.isValidElement(node), 'screen must return renderable React elements');
  const element = node as React.ReactElement<{ children?: unknown }>;
  const host = typeof element.type === 'string' ? element.type : parentHost;
  inspect(element.props.children, host, text);
}

for (const scenario of [
  { name: 'empty initial state', data: false, error: '', notice: '', offline: false },
  { name: 'loading state', data: false, error: '', notice: '', offline: false, loading: true },
  { name: 'normal candidate and selection state', data: true, error: '', notice: '', offline: false },
  { name: 'save error state', data: true, error: '保存を確認できませんでした。', notice: '', offline: false },
  { name: 'saved notice state', data: true, error: '', notice: '共有する商品を保存しました。', offline: false },
  { name: 'offline retained selection state', data: true, error: '', notice: '', offline: true },
]) {
  test(`native screen renders ${scenario.name} without raw text under View`, () => {
    const controller = new selection.CatalogSelectionController(ports);
    controller.state = { ...controller.state, loading: scenario.loading ?? false, error: scenario.error, notice: scenario.notice, ...(scenario.data ? { id: grant.id, grants: [grant, { ...grant, id: 'two', label: '取引先B' }], data: { grant, candidates: [item, { ...item, id: 'table', name: 'テーブル', imageUrl: '/api/inventory/partner-catalog/image/table' }], maxSelectedItems: 500 }, draft: ['chair', 'sold'] } : {}) };
    const tree = screenModule.exports.PartnerCatalogScreen({ ports, offline: scenario.offline, retainedController: controller, onClose: () => {} });
    const renderedText: string[] = []; inspect(tree, null, renderedText);
    const content = renderedText.join('');
    assert.ok(content.includes('社外共有'));
    if (scenario.error) assert.ok(content.includes(scenario.error));
    if (scenario.notice) assert.ok(content.includes(scenario.notice));
    if (scenario.offline) assert.ok(content.includes('圏外です。'));
    if (scenario.data) { assert.ok(content.includes(item.name)); assert.ok(content.includes('対象外になった選択が')); }
    else if (!scenario.loading) assert.ok(content.includes('共有リンクはありません。'));
  });
}

type InspectedProps = { children?: unknown; accessibilityRole?: string; accessibilityLabel?: string; type?: string; className?: string; 'aria-label'?: string; style?: Array<false | { minHeight?: number }>; onPress(): void; onClick(): void };
function elements(node: unknown): React.ReactElement<InspectedProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  const element = node as React.ReactElement<InspectedProps>; return [element, ...elements(element.props.children)];
}
test('native candidate actions respect search and success removes saved rows; registered view can deregister individually', async () => {
  let saved = { ...grant, selectedIds: ['chair'] };
  const candidates = [{ ...item, imageUrl: '/api/inventory/partner-catalog/image/chair' }, { ...item, id: 'table', name: 'テーブル' }, { ...item, id: 'other', name: 'キャビネット' }];
  const localPorts: selection.CatalogSelectionPorts = { ...ports, list: async () => [saved], read: async () => ({ grant: saved, candidates, maxSelectedItems: 500 }), save: async (_id, revision, selectedIds) => { saved = { ...saved, revision: revision + 1, selectedIds }; return saved; } };
  const controller = new selection.CatalogSelectionController(localPorts); await controller.start();
  const render = () => elements(screenModule.exports.PartnerCatalogScreen({ ports: localPorts, offline: false, retainedController: controller, onClose: () => {} }));
  searchQuery = 'テーブル';
  try {
    let tree = render(); assert.equal(tree.filter(e => e.props.accessibilityRole === 'checkbox').length, 1);
    tree.find(e => e.props.accessibilityLabel === '全選択')!.props.onPress(); assert.deepEqual(controller.state.draft, ['table']);
    tree = render(); await tree.find(e => e.props.accessibilityLabel === '選択した商品を登録（1件）')!.props.onPress();
    // The screen intentionally detaches the async action; settle its resolved save.
    await Promise.resolve(); assert.deepEqual(saved.selectedIds, ['chair', 'table']);
    assert.equal(render().filter(e => e.props.accessibilityRole === 'checkbox').length, 0);
    registeredView = true; searchQuery = ''; tree = render();
    assert.equal(tree.filter(e => String(e.props.accessibilityLabel).endsWith('の登録を解除')).length, 2);
    assert.equal(tree.some(e => e.props.accessibilityLabel === '全解除'), false);
    const registeredCards = tree.filter(e => e.type === 'View' && Array.isArray(e.props.style) && e.props.style.some(style => style && style.minHeight === 96));
    assert.equal(registeredCards.length, 2);
    for (const card of registeredCards) {
      assert.equal(card.props.onPress, undefined, 'registered cards must not deregister when tapped');
      assert.equal(elements(card).filter(e => e.type === 'Pressable').length, 1, 'only the explicit removal button is interactive');
    }
    assert.equal(tree.find(e => e.type === 'Image' && e.props.accessibilityLabel === item.name + 'の写真')!.props.onPress, undefined);
    assert.equal(tree.find(e => e.type === 'Text' && e.props.children === item.name)!.props.onPress, undefined);
    const removeButton = tree.find(e => e.props.accessibilityLabel === item.name + 'の登録を解除')!;
    assert.equal(removeButton.type, 'Pressable');
    assert.ok(removeButton.props.style?.some(style => style && style.minHeight === 44), 'explicit removal has a 44px minimum target');
    removeButton.props.onPress(); await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(saved.selectedIds, ['table']);
    registeredView = false; assert.ok(render().some(e => e.props.accessibilityRole === 'checkbox' && e.props.accessibilityLabel === item.name + ' ' + item.stageLabel));
  } finally { registeredView = false; searchQuery = ''; }
});
