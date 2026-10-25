import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import { analyzeStudioPhoto, estimateStudioLevel } from '../src/autoFraming.mjs';

test('壁と明るさが近い白いベンチでも天板と全ての脚を残す',async()=>{
 const file=fileURLToPath(new URL('./fixtures/neutral-bench.jpg',import.meta.url));
 const result=await analyzeStudioPhoto(file);
 assert.equal(result.status,'READY');assert.equal(result.subjectSource,'neutral-panel');
 const box=result.subjectBox;
 assert.ok(box.left<=245&&box.left+box.width>=494,JSON.stringify(box));
 assert.ok(box.top<=130&&box.top+box.height>=318,JSON.stringify(box));
});

test('白いベンチの撮影方向が左右逆でも脚の下端まで残す',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'bello-neutral-panel-')),file=path.join(dir,'reversed.jpg');
 await sharp(fileURLToPath(new URL('./fixtures/neutral-bench.jpg',import.meta.url))).flop().jpeg({quality:95}).toFile(file);
 const result=await analyzeStudioPhoto(file);
 assert.equal(result.status,'READY');const box=result.subjectBox;
 assert.ok(box.left<=274&&box.left+box.width>=523,JSON.stringify(box));
 assert.ok(box.top<=130&&box.top+box.height>=318,JSON.stringify(box));
});

async function tintedRoom(subject) {
 const dir=await mkdtemp(path.join(tmpdir(),'bello-colour-room-')),file=path.join(dir,'photo.png');
 const svg=`<svg width="600" height="400"><defs><linearGradient id="wall"><stop stop-color="#625052"/><stop offset=".6" stop-color="#a18b8b"/><stop offset="1" stop-color="#090809"/></linearGradient></defs><rect width="600" height="400" fill="url(#wall)"/>${subject}</svg>`;
 await sharp(Buffer.from(svg)).png().toFile(file);return file;
}
test('赤い照明を色付きの壁・暗い室内から分離し、輪郭を残す',async()=>{
 const result=await analyzeStudioPhoto(await tintedRoom('<ellipse cx="300" cy="220" rx="43" ry="85" fill="#cb171b"/>'));
 assert.equal(result.status,'READY');
 assert.ok(result.subjectBox.left<=260&&result.subjectBox.left+result.subjectBox.width>=340);
 assert.ok(result.subjectBox.top<=140&&result.subjectBox.top+result.subjectBox.height>=300);
 assert.ok(result.subjectBox.width<300&&result.subjectBox.height<330);
});
test('色付きの壁だけ、または端まで続く赤色領域を商品と決めつけない',async()=>{
 for(const shape of ['', '<rect x="250" y="0" width="100" height="400" fill="#cb171b"/>'])
  assert.equal((await analyzeStudioPhoto(await tintedRoom(shape))).status,'NEEDS_REVIEW');
});

/**
 * A neutral studio frame like the real table photos: no chroma anywhere, a
 * strong left-to-right lighting falloff, a wall/floor step, and optionally a
 * white product. The falloff is what used to force every such photo to review.
 */
async function neutralScene({ subject, width = 600, height = 400, horizon = 0.62 }) {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const edge = Math.abs(x / (width - 1) - 0.5) * 2;
      let value = (y / height < horizon ? 186 : 214) - Math.round(edge * edge * 78);
      if (subject && x >= subject.left && x < subject.left + subject.width
        && y >= subject.top && y < subject.top + subject.height) value = 246;
      for (let c = 0; c < 3; c++) data[(y * width + x) * 3 + c] = value;
    }
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'bello-framing-'));
  const file = path.join(dir, 'neutral.png');
  await sharp(data, { raw: { width, height, channels: 3 } }).png().toFile(file);
  return file;
}

test('背景と区別できる中央の被写体だけを候補にする', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bello-framing-'));
  const file = path.join(dir, 'studio.jpg');
  await sharp({ create: { width: 600, height: 400, channels: 3, background: '#dddddd' } })
    .composite([{ input: { create: { width: 180, height: 220, channels: 3, background: '#835c38' } },
      left: 210, top: 100 }]).jpeg({ quality: 95 }).toFile(file);
  const result = await analyzeStudioPhoto(file);
  assert.equal(result.status, 'READY');
  assert.equal(result.subjectSource, 'contrast');
  assert.ok(result.subjectBox.left >= 180 && result.subjectBox.left <= 230);
  assert.ok(result.subjectBox.width >= 150 && result.subjectBox.width <= 230);
});

test('無地背景では被写体を決め打ちしない', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bello-framing-'));
  const file = path.join(dir, 'empty.jpg');
  await sharp({ create: { width: 600, height: 400, channels: 3, background: '#dddddd' } }).jpeg().toFile(file);
  assert.equal((await analyzeStudioPhoto(file)).status, 'NEEDS_REVIEW');
  assert.equal((await estimateStudioLevel(file)).status, 'NEEDS_REVIEW');
});

test('無彩色の白い商品でも中央なら被写体として特定する', async () => {
  const file = await neutralScene({ subject: { left: 225, top: 90, width: 150, height: 180 } });
  const result = await analyzeStudioPhoto(file);
  assert.equal(result.status, 'READY');
  assert.equal(result.subjectSource, 'neutral');
  // The box must cover the product; a few pixels of slack is fine, cutting is not.
  assert.ok(result.subjectBox.left <= 225 + 8 && result.subjectBox.left >= 225 - 24);
  assert.ok(result.subjectBox.left + result.subjectBox.width >= 375 - 8);
  assert.ok(result.subjectBox.top <= 90 + 8 && result.subjectBox.top + result.subjectBox.height >= 270 - 8);
});

test('照明ムラと床の境目だけの無彩色写真を被写体扱いしない', async () => {
  const result = await analyzeStudioPhoto(await neutralScene({ subject: null }));
  assert.equal(result.status, 'NEEDS_REVIEW');
  assert.match(result.reason, /安全に特定できません/);
});

test('無彩色でも中央から外れた被写体では自動トリミングしない', async () => {
  const file = await neutralScene({ subject: { left: 60, top: 90, width: 150, height: 180 } });
  assert.equal((await analyzeStudioPhoto(file)).status, 'NEEDS_REVIEW');
});

test('無彩色で横に広すぎる被写体は輪郭を確かめられないので確認待ち', async () => {
  const file = await neutralScene({ subject: { left: 75, top: 90, width: 450, height: 180 } });
  assert.equal((await analyzeStudioPhoto(file)).status, 'NEEDS_REVIEW');
});

/**
 * The failure this whole gate exists for. On the real table photos the neutral
 * plateau ran the full height of the frame — box top 0, height the entire
 * image — while staying inside the horizontal limits, and was returned READY.
 * A region reaching the top or bottom edge continues outside the photo, so its
 * real extent is unknown and it can never be measured for a crop.
 */
test('上端・下端に接する明るい領域は被写体として採用しない', async () => {
  for (const subject of [
    { left: 225, top: 0, width: 150, height: 400 },   // top and bottom: the real failure
    { left: 225, top: 0, width: 150, height: 200 },   // top only
    { left: 225, top: 200, width: 150, height: 200 }, // bottom only
  ]) {
    const result = await analyzeStudioPhoto(await neutralScene({ subject }));
    assert.equal(result.status, 'NEEDS_REVIEW', JSON.stringify(subject));
    assert.equal(result.subjectBox, undefined);
  }
});

test('左右端に接する明るい領域も同じく採用しない', async () => {
  for (const subject of [
    { left: 0, top: 90, width: 320, height: 180 },
    { left: 280, top: 90, width: 320, height: 180 },
  ]) {
    const result = await analyzeStudioPhoto(await neutralScene({ subject }));
    assert.equal(result.status, 'NEEDS_REVIEW', JSON.stringify(subject));
  }
});

// Whatever path runs and whatever it concluded internally, the value handed
// back must never be a box that reaches the frame border.
test('READYで返る被写体領域は必ず四辺とも画像の内側にある', async () => {
  const files = [
    await neutralScene({ subject: { left: 225, top: 90, width: 150, height: 180 } }),
    await neutralScene({ subject: { left: 225, top: 0, width: 150, height: 400 } }),
    await neutralScene({ subject: null }),
    await neutralScene({ subject: { left: 60, top: 90, width: 150, height: 180 } }),
  ];
  for (const file of files) {
    const result = await analyzeStudioPhoto(file);
    if (result.status !== 'READY') continue;
    const { left, top, width, height } = result.subjectBox;
    assert.ok(left > 0 && top > 0, JSON.stringify(result.subjectBox));
    assert.ok(left + width < result.width && top + height < result.height, JSON.stringify(result.subjectBox));
  }
});

test('黒い背もたれと細い脚を木色の座面と一緒に検出する', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bello-dark-chair-'));
  const file = path.join(dir, 'chair.png');
  const drawing = Buffer.from('<svg width="600" height="400"><defs><radialGradient id="wall"><stop stop-color="#eeeeee"/><stop offset="1" stop-color="#777777"/></radialGradient></defs><rect width="600" height="400" fill="url(#wall)"/><path d="M235 110 H365 V180 H350 V125 H250 V180 H235 Z" fill="#111111"/><rect x="235" y="180" width="130" height="22" fill="#906343"/><path d="M240 202 H253 V315 H240 Z M347 202 H360 V315 H347 Z" fill="#161616"/></svg>');
  await sharp(drawing).png().toFile(file);
  const result = await analyzeStudioPhoto(file);
  assert.equal(result.status, 'READY');
  assert.ok(result.subjectBox.top <= 112);
  assert.ok(result.subjectBox.top + result.subjectBox.height >= 312);
  assert.ok(result.subjectBox.left <= 237 && result.subjectBox.left + result.subjectBox.width >= 362);
});
