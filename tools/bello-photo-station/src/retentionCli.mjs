#!/usr/bin/env node
import path from 'node:path';
import { isMainModule } from './isMainModule.mjs';
import { cleanupExpiredSources, cleanupExpiredLightroomCopies } from './retention.mjs';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function main(args = process.argv.slice(2)) {
  const [rootArg, approvedJson, mode = 'inspect'] = args;
  if (!rootArg || !approvedJson || !['inspect', 'execute'].includes(mode)) throw new Error('保存先・承認済みセッション・モードを指定してください');
  const parsed = JSON.parse(approvedJson);
  if (!Array.isArray(parsed) || parsed.some(id => typeof id !== 'string' || !SESSION_ID.test(id)))
    throw new Error('承認済みセッションの一覧が不正です');
  const approved = new Set(parsed.map(id => id.toLowerCase()));
  const result = await cleanupExpiredSources(path.resolve(rootArg), {
    canDelete: async id => mode === 'execute' && approved.has(id.toLowerCase()),
  });
  const lightroom = { expired: [], removed: [], skipped: [] };
  // Touch mode can share the installed Lightroom bridge at a different root.
  for (const bridgeRoot of new Set([path.resolve(rootArg), path.resolve(process.env.BELLO_LIGHTROOM_BRIDGE_ROOT || rootArg)])) {
    const cleaned = await cleanupExpiredLightroomCopies(bridgeRoot, { execute: mode === 'execute' });
    for (const key of ['expired', 'removed', 'skipped']) lightroom[key].push(...cleaned[key]);
  }
  return { mode, ...result, lightroom };
}

if (isMainModule(import.meta.url))
  main().then(result => console.log('RESULT_JSON:' + JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
