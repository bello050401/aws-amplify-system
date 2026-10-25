import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {analyzeDetailFocus} from '../src/detailFocus.mjs';
import {detailCrop} from '../src/productFraming.mjs';

async function fixture(t,shape) {
  const root=await mkdtemp(path.join(tmpdir(),'bello-detail-focus-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const file=path.join(root,'source.jpg');
  await sharp(Buffer.from(`<svg width="1200" height="800"><defs><linearGradient id="wall"><stop stop-color="#eee"/><stop offset="1" stop-color="#bbb"/></linearGradient></defs><rect width="1200" height="800" fill="url(#wall)"/>${shape}</svg>`)).jpeg().toFile(file);
  return file;
}
test('上下が切れたアップ写真は左右の輪郭の中心を取り、撮影倍率を保つ',async t=>{
  const f=await fixture(t,'<rect x="220" y="120" width="600" height="800" rx="90" fill="#242424"/><rect x="310" y="230" width="420" height="200" fill="#ddd"/><rect x="260" y="500" width="520" height="200" fill="#b27b53"/>');
  const focus=await analyzeDetailFocus(f);
  assert.ok(focus&&Math.abs(focus.x-520/1200)<.012);
  const crop=detailCrop({width:1200,height:800,aspectRatio:1,detailFocus:focus});
  assert.ok(Math.abs(crop.left+crop.width/2-520)<15);
  assert.equal(crop.width,800); assert.equal(crop.height,800);
  assert.equal(crop.top,0);
});
test('背景の明暗だけでは拡大中心を移動しない',async t=>{
  assert.equal(await analyzeDetailFocus(await fixture(t,'')),null);
});
test('片側が写真の外に切れている場合は全体位置を推測しない',async t=>{
  const focus=await analyzeDetailFocus(await fixture(t,'<rect x="0" y="100" width="680" height="800" fill="#242424"/>'));
  assert.equal(focus,null);
});
test('小さな傷やラベルへフォーカスを移さない',async t=>{
  const focus=await analyzeDetailFocus(await fixture(t,'<rect x="300" y="300" width="60" height="30" fill="#222"/>'));
  assert.equal(focus,null);
});
