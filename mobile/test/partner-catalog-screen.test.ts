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
const screenModule = { exports: {} as { PartnerCatalogScreen: (props: unknown) => React.ReactElement } };
vm.runInNewContext(source, {
  exports: screenModule.exports,
  require(name: string) {
    if (name === 'react') return { __esModule: true, default: React, useMemo: (factory: () => unknown) => factory(), useState: (initial: unknown) => [initial, () => {}], useEffect: () => {} };
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
