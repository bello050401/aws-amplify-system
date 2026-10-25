import test from 'node:test';
import assert from 'node:assert/strict';
import { planProductFraming, safeCropForSubject, squareCropFromTopAnchor,detailCrop,framingIntent } from '../src/productFraming.mjs';
import { prepareProductFraming } from '../src/productFraming.mjs';
import { sha256File } from '../src/processImage.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const image = (assetId, subjectBox, width = 1200, height = 800) => ({ assetId, width, height, subjectBox });

test('トップが正方形に収まれば商品全体を正方形に統一する', () => {
  const plan = planProductFraming({ topAssetId: 'top', images: [
    image('top', { left: 400, top: 150, width: 350, height: 460 }),
    image('side', { left: 430, top: 120, width: 300, height: 530 }),
  ] });
  assert.equal(plan.status, 'READY');
  assert.equal(plan.aspectRatio, 1);
  for (const crop of Object.values(plan.crops)) assert.equal(crop.width, crop.height);
});

test('トップが正方形に収まらない場合は全画像3:2', () => {
  const plan = planProductFraming({ topAssetId: 'top', images: [
    image('top', { left: 140, top: 270, width: 920, height: 200 }),
    image('side', { left: 350, top: 180, width: 460, height: 410 }),
  ] });
  assert.equal(plan.status, 'READY');
  assert.equal(plan.aspectRatio, 1.5);
  for (const crop of Object.values(plan.crops)) assert.equal(crop.width * 2, crop.height * 3);
});

test('縦長トップが正方形にも3:2にも入らない場合は3:2で切り抜き、余白を足さない', () => {
  const plan = planProductFraming({ topAssetId: 'top', images: [
    image('top', { left: 240, top: 120, width: 320, height: 940 }, 800, 1200),
    image('side', { left: 270, top: 180, width: 270, height: 760 }, 800, 1200),
  ] });
  assert.equal(plan.status, 'READY');
  assert.equal(plan.aspectRatio, 1.5);
  assert.ok(plan.crops.top);
  assert.equal(plan.crops.top.width / plan.crops.top.height, 1.5);
  assert.deepEqual(plan.containAssetIds, []);
});

test('横長の追加写真によってメインの正方形を3:2へ変えない', () => {
  const plan = planProductFraming({ topAssetId: 'top', images: [
    image('top', { left: 400, top: 150, width: 350, height: 460 }),
    image('wide', { left: 80, top: 250, width: 1040, height: 230 }),
  ] });
  assert.equal(plan.status, 'READY');
  assert.equal(plan.aspectRatio, 1);
  assert.equal(plan.crops.top.width, plan.crops.top.height);
  assert.equal(plan.crops.wide.width, plan.crops.wide.height);
});

test('検出値が欠けても基本の正方形を維持して元写真の中央を切り抜く', () => {
  const plan = planProductFraming({ topAssetId: 'top', images: [image('top', null)] });
  assert.equal(plan.status, 'READY');
  assert.equal(plan.aspectRatio, 1);
  assert.equal(plan.crops.top.width, plan.crops.top.height);
  assert.equal(safeCropForSubject({ width: 100, height: 100, subjectBox: { left: -1, top: 0, width: 10, height: 10 }, aspectRatio: 1 }), null);
});

test('トップ基準の正方形は通常の横長写真だけに適用する', () => {
  assert.deepEqual(squareCropFromTopAnchor({ width: 1200, height: 800, topCentreFraction: 0.5 }),
    { left: 200, top: 0, width: 800, height: 800 });
  assert.equal(squareCropFromTopAnchor({ width: 1800, height: 800, topCentreFraction: 0.5 }), null);
  assert.equal(squareCropFromTopAnchor({ width: 800, height: 1200, topCentreFraction: 0.5 }), null);
  assert.equal(squareCropFromTopAnchor({ width: 1200, height: 800, topCentreFraction: 0.2 }), null);
});

test('全体写真は余白不足なら横長を選び、拡大写真は切り取った構図を保つ', () => {
  // The real top-down table shot: the leg runs to the bottom edge, so there is
  // no bottom margin to keep and demanding one used to force the whole product to 3:2.
  const frame = { width: 3936, height: 2216, subjectBox: { left: 1063, top: 288, width: 1889, height: 1928 } };
  const crop = safeCropForSubject({ ...frame, aspectRatio: 1,margin:.06 });
  assert.equal(crop.width, crop.height);
  assert.ok(crop.left <= frame.subjectBox.left);
  assert.ok(crop.left + crop.width >= frame.subjectBox.left + frame.subjectBox.width);
  assert.ok(crop.top + crop.height >= frame.subjectBox.top + frame.subjectBox.height);
  const plan = planProductFraming({ topAssetId: 'top', images: [{ assetId: 'top', ...frame }] });
  assert.equal(plan.aspectRatio, 1.5);
  const detail=planProductFraming({topAssetId:'top',images:[{assetId:'top',...frame,framingMode:'detail'}]});
  assert.equal(detail.aspectRatio,1);
  assert.ok(detail.crops.top);
});

test('拡大写真は上下に帯を足さず撮影倍率を保ち、画像の外を補わない',()=>{
  const crop=detailCrop({width:3936,height:2216,aspectRatio:1});
  assert.equal(crop.height,2216);assert.equal(crop.width,2216);
  assert.ok(crop.left>=0&&crop.left+crop.width<=3936);
  assert.equal(framingIntent({fileName:'⑧.JPG',detection:{status:'NEEDS_REVIEW'}}),'detail');
  assert.equal(framingIntent({fileName:'⑧.JPG',detection:{status:'READY'}}),'whole');
  assert.equal(framingIntent({fileName:'①.JPG',detection:{status:'NEEDS_REVIEW'}}),'whole');
  assert.equal(framingIntent({fileName:'⑧.JPG',isMain:true,detection:{status:'NEEDS_REVIEW'}}),'whole');
});

test('傾き補正で空白の角ができる写真は端の商品を保証できないので切らない', () => {
  const frame = { width: 1200, height: 800, subjectBox: { left: 0, top: 100, width: 400, height: 300 } };
  assert.equal(safeCropForSubject({ ...frame, aspectRatio: 1, safeInset: 10 }), null);
  assert.ok(safeCropForSubject({ ...frame, aspectRatio: 1 }));
});

test('アップ写真は偏った被写体検出でも撮影画像の中央から切り取る',()=>{
  for(const subjectBox of [null,{left:650,top:100,width:500,height:600},{left:40,top:20,width:300,height:500}]) {
    assert.deepEqual(detailCrop({width:1200,height:800,aspectRatio:1,subjectBox}),
      {left:200,top:0,width:800,height:800});
    assert.deepEqual(detailCrop({width:800,height:1200,aspectRatio:1.5,subjectBox}),
      {left:1,top:334,width:798,height:532});
  }
});

test('全体が収まらない追加写真も検出位置へ寄せず中央へフォーカスする',()=>{
  const plan=planProductFraming({topAssetId:'top',images:[
    image('top',{left:400,top:150,width:350,height:460}),
    image('closeup',{left:150,top:100,width:900,height:690}),
    {...image('detail',{left:650,top:100,width:500,height:600}),framingMode:'detail'},
  ]});
  assert.equal(plan.aspectRatio,1);
  assert.deepEqual(plan.crops.closeup,{left:200,top:0,width:800,height:800});
  assert.deepEqual(plan.crops.detail,plan.crops.closeup);
  assert.deepEqual(plan.containAssetIds,[]);
});

test('中央切り取りは傾き補正の余白を除き端数でも中心を0.5px以内に保つ',()=>{
  for(const [width,height] of [[1201,803],[803,1201],[1200,800]]) {
    for(const aspectRatio of [1,1.5]) {
      const c=detailCrop({width,height,aspectRatio,safeInset:25});
      assert.ok(c.left>=25&&c.top>=25&&c.left+c.width<=width-25&&c.top+c.height<=height-25);
      assert.equal(c.width/c.height,aspectRatio);
      assert.ok(Math.abs(c.left+c.width/2-width/2)<=.5);
      assert.ok(Math.abs(c.top+c.height/2-height/2)<=.5);
    }
  }
  for(const safeInset of [-1,NaN,.5,400])assert.equal(detailCrop({width:1200,height:800,aspectRatio:1,safeInset}),null);
});

test('判定不能な写真でも原本に紐づく手動補正を再現できる', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bello-framing-plan-'));
  const sourcePath = path.join(root, 'original.jpg');
  await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#dddddd' } }).jpeg().toFile(sourcePath);
  const source = { clientAssetId: '001', fileName: 'original.jpg', sourcePath };
  const override = { sourceHash: await sha256File(sourcePath), angle: 0,
    subjectBox: { left: 430, top: 130, width: 340, height: 500 } };
  const input = { sources: [source], topFileName: source.fileName,
    selectedPresets: new Map([[source.fileName, { preset: { hash: 'p' }, signature: 'p' }]]),
    outputRoot: root, stationRoot: root, settings: { longEdgePx: 1200 },
    render: async () => ({ path: sourcePath, signature: 'p' }),
    detect: async () => ({ status: 'NEEDS_REVIEW' }),
    level: async () => ({ status: 'NEEDS_REVIEW' }) };
  const plan = await prepareProductFraming({ ...input, overrides: { [source.fileName]: override } });
  assert.equal(plan.status, 'READY');
  assert.equal(plan.aspectRatio, 1);
  assert.match(plan.confirmationHash, /^[a-f0-9]{64}$/);
  const changed = await prepareProductFraming({ ...input,
    overrides: { [source.fileName]: { ...override, sourceHash: 'stale' } } });
  assert.equal(changed.status, 'NEEDS_REVIEW');
});

test('水平が測れなくても被写体が確定していれば他写真の中心に頼らず正方形にする', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bello-framing-unlevel-'));
  const sourcePath = path.join(root, 'top.jpg');
  await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#dddddd' } }).jpeg().toFile(sourcePath);
  const source = { clientAssetId: '001', fileName: 'top.jpg', sourcePath };
  const plan = await prepareProductFraming({ sources: [source], topFileName: 'top.jpg',
    selectedPresets: new Map([['top.jpg', { preset: { hash: 'p' }, signature: 'p' }]]),
    outputRoot: root, stationRoot: root, settings: { longEdgePx: 1200 },
    render: async () => ({ path: sourcePath, signature: 'p' }),
    level: async () => ({ status: 'NEEDS_REVIEW', angle: 0 }),
    detect: async () => ({ status: 'READY', width: 1200, height: 800,
      subjectBox: { left: 420, top: 130, width: 360, height: 500 } }) });
  assert.equal(plan.status, 'READY');
  assert.equal(plan.aspectRatio, 1);
  assert.equal(plan.anchoredAssetIds, undefined);
  // Left as shot: an unmeasurable horizon must still never rotate the photo.
  assert.equal(plan.frames.get('001').angle, 0);
});

test('判定不能な写真はトップと同じ正方形に切り抜く', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bello-framing-contain-'));
  const sources = [];
  for (const name of ['top.jpg', 'white.jpg']) {
    const sourcePath = path.join(root, name);
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#dddddd' } }).jpeg().toFile(sourcePath);
    sources.push({ clientAssetId: name, fileName: name, sourcePath });
  }
  let detectedCount = 0;
  const plan = await prepareProductFraming({ sources, topFileName: 'top.jpg',
    selectedPresets: new Map(sources.map(s => [s.fileName, { preset: { hash: 'p' }, signature: 'p' }])),
    outputRoot: root, stationRoot: root, settings: { longEdgePx: 1200 },
    render: async ({ sourcePath }) => ({ path: sourcePath, signature: 'p' }),
    level: async () => ({ status: 'READY', angle: 0 }),
    detect: async () => ++detectedCount === 2 ? { status: 'NEEDS_REVIEW' }
      : { status: 'READY', width: 1200, height: 800, subjectBox: { left: 420, top: 130, width: 360, height: 500 } } });
  assert.equal(plan.status, 'READY');
  assert.equal(plan.aspectRatio, 1);
  assert.equal(plan.crops['white.jpg'].width, plan.crops['white.jpg'].height);
  assert.deepEqual(plan.containAssetIds, []);
  assert.ok(plan.crops['top.jpg']);
});
