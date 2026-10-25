import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import luaparse from 'luaparse';
test('Lightroom plugin parses as Lua 5.1 supported by Lightroom', async () => {
  for (const file of ['Info.lua', 'Start.lua', 'Stop.lua', 'Connect.lua']) {
    const source = await readFile(new URL(`../lightroom/BelloPhotoStation.lrplugin/${file}`, import.meta.url), 'utf8');
    assert.ok(luaparse.parse(source, { luaVersion: '5.1' }));
  }
});
