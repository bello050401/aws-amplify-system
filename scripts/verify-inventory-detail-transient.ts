import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

declare module 'node:module' {
  export function registerHooks(hooks: {
    resolve?: (specifier: string, context: { parentURL?: string }, nextResolve: (specifier: string, context: unknown) => unknown) => unknown;
  }): void;
}

const root = pathToFileURL(process.cwd() + '/').href;
const mocks = root + 'scripts/__mocks__/';
const queriesUrl = mocks + 'inventoryDetailTransient.queries.mock.cjs';
const roleUrl = mocks + 'inventoryDetailTransient.role.mock.cjs';
const noopUrl = mocks + 'inventoryDetailTransient.noop.mock.cjs';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/lib/inventory/queries') return { url: queriesUrl, shortCircuit: true };
    if (specifier === '@/lib/amplify/requireInventoryUser') return { url: roleUrl, shortCircuit: true };
    if (specifier === '@/app/actions/photoRegistration') return { url: noopUrl, shortCircuit: true };
    if (specifier === '@/app/inventory/(protected)/[id]/page' || specifier === '@/lib/amplify/cognitoTransientError' || specifier === '../InventoryAuthTemporarilyUnavailable') {
      const target = specifier.startsWith('@/') ? root + specifier.slice(2) : specifier;
      try { return nextResolve(target, context); }
      catch {
        try { return nextResolve(target + '.ts', context); }
        catch { return nextResolve(target + '.tsx', context); }
      }
    }
    if (specifier.startsWith('@/') || specifier.startsWith('./') || specifier.startsWith('../')) {
      return { url: noopUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

async function main() {
  // tsx executes this page's preserved JSX outside Next's automatic runtime.
  (globalThis as { React?: unknown }).React = (await import('react')).default;
  const { default: InventoryDetailPage } = await import('@/app/inventory/(protected)/[id]/page');
  const queries = (await import(queriesUrl)).default;
  const roles = (await import(roleUrl)).default;
  const params = { id: 'inventory-test' };
  const searchParams = {};

  queries.__setPhase('first');
  const first = await InventoryDetailPage({ params, searchParams });
  const firstHtml = renderToStaticMarkup(first);
  assert.match(firstHtml, /認証サービスが一時的に混み合っています/);
  assert.doesNotMatch(firstHtml, /inventory-test/, '読取途中の在庫IDを表示しない');
  assert.deepEqual(queries.calls, { item: 1, statuses: 1, fields: 1, categories: 0, locations: 0 }, '初段の読取を再試行しない');

  queries.__setPhase('second');
  const second = await InventoryDetailPage({ params, searchParams });
  const secondHtml = renderToStaticMarkup(second);
  assert.match(secondHtml, /認証サービスが一時的に混み合っています/);
  assert.doesNotMatch(secondHtml, /inventory-test/, '一部の読取が成功しても在庫データを表示しない');
  assert.deepEqual(queries.calls, { item: 1, statuses: 1, fields: 1, categories: 1, locations: 1 }, '後段も再試行しない');

  queries.__setPhase('unknown');
  await assert.rejects(() => InventoryDetailPage({ params, searchParams }), (error: unknown) => error === queries.unexpected, '未知エラーは既存境界へ');

  queries.__setPhase('first');
  roles.__setRole(null);
  assert.equal(await InventoryDetailPage({ params, searchParams }), null, '非認可時はデータを読まない');
  assert.equal(queries.calls.item, 0);
  console.log('[verify-inventory-detail-transient] passed');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
