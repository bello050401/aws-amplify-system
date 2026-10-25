import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {touchCrop,makeTouchPreview} from '../src/touchFraming.mjs';
import {prepareProductFraming} from '../src/productFraming.mjs';
import {sha256File} from '../src/processImage.mjs';

test('touch crop covers the frame without padding at every edge, shape and zoom',()=>{
  for(const [width,height] of [[3936,2216],[2216,3936],[800,800]])
  for(const aspectRatio of [1,1.5])for(const zoom of [1,1.37,4])
  for(const centerX of [0,.5,1])for(const centerY of [0,.5,1]){
    const c=touchCrop({width,height,aspectRatio,zoom,centerX,centerY});
    assert.equal(c.width/c.height,aspectRatio);
    assert.ok(c.left>=0&&c.top>=0&&c.left+c.width<=width&&c.top+c.height<=height);
  }
  assert.throws(()=>touchCrop({width:400,height:300,aspectRatio:1,centerX:.5,centerY:.5,zoom:NaN}));
});
test('preview honors EXIF rotation and supports a long session path',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'touch-preview-'));
  const source=path.join(root,'portrait.jpg');
  await sharp({create:{width:1800,height:1200,channels:3,background:'#abcdef'}}).jpeg().withMetadata({orientation:6}).toFile(source);
  const session=path.join(root,...Array(8).fill('long-session-directory-123456789'));
  const p=await makeTouchPreview({sourcePath:source,fileName:'portrait.jpg'},session);
  assert.equal(p.width,1200);assert.equal(p.height,1800);
  const m=await sharp(await readFile(p.path)).metadata();
  assert.ok(m.height>m.width&&m.height<=1280);
  assert.equal((await makeTouchPreview({sourcePath:source,fileName:'portrait.jpg'},session)).path,p.path);
});
test('manual positions survive rendering and repeat saves; auto detection cannot move them',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'touch-plan-'));
  const sources=[];
  for(const fileName of ['top.jpg','detail.jpg']){
    const sourcePath=path.join(root,fileName);
    await sharp({create:{width:1200,height:800,channels:3,background:'#ccaa88'}}).jpeg().toFile(sourcePath);
    sources.push({fileName,sourcePath,clientAssetId:fileName});
  }
  const items={};
  for(const s of sources)items[s.fileName]={sourceHash:await sha256File(s.sourcePath),width:1200,height:800,centerX:.65,centerY:.6,zoom:1.5};
  const saved={version:1,completed:true,topFileName:'top.jpg',aspectRatio:1,items};
  await writeFile(path.join(root,'touch-framing.json'),JSON.stringify(saved));
  let renders=0;
  const args={sources,topFileName:'top.jpg',selectedPresets:new Map(sources.map(s=>[s.fileName,{preset:{hash:'p'},signature:'p'}])),
    outputRoot:root,stationRoot:root,settings:{longEdgePx:1200},
    render:async o=>{assert.equal(o.preserveFraming,true);renders++;return{path:o.sourcePath,signature:'p'};},
    level:async()=>{throw new Error('must not rotate');},detectDetail:async()=>{throw new Error('must not reframe');},
    detect:async()=>({status:'NEEDS_REVIEW'})};
  const first=await prepareProductFraming(args);
  assert.equal(first.status,'READY');
  assert.deepEqual(first.crops['detail.jpg'],touchCrop({...items['detail.jpg'],aspectRatio:1}));
  const second=await prepareProductFraming(args);
  assert.deepEqual(second.crops,first.crops);assert.equal(renders,1); // same source bytes share verified render
  saved.items['detail.jpg'].sourceHash='changed';
  await writeFile(path.join(root,'touch-framing.json'),JSON.stringify(saved));
  assert.equal((await prepareProductFraming(args)).status,'NEEDS_REVIEW');
});
