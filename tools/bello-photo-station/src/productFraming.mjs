import { imagePath } from './imagePath.mjs';
/**
 * Product-level framing geometry. Detection is deliberately a separate input:
 * an uncertain subject or horizon must never trigger a destructive crop.
 * All boxes and crop rectangles use pixels in the auto-oriented image.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { analyzeStudioPhoto, estimateStudioLevel } from './autoFraming.mjs';
import { sha256File } from './processImage.mjs';
import { renderCachedLightroom } from './lightroomRenderer.mjs';
import { recoverSourceFraming } from './sourceFraming.mjs';
import { analyzeDetailFocus } from './detailFocus.mjs';
import { touchCrop } from './touchFraming.mjs';
function validBox(box, width, height) {
  return box && [box.left, box.top, box.width, box.height].every(Number.isFinite)
    && box.left >= 0 && box.top >= 0 && box.width > 0 && box.height > 0
    && box.left + box.width <= width && box.top + box.height <= height;
}

/** A box that stands clear of every frame edge, so its outline was actually
 * seen rather than assumed to continue past the photo. Detection must meet
 * this before anything is cropped against it; a hand-drawn override need not,
 * because a person looked at the photo and decided the product runs to the edge. */
function detectedBoxIsUsable(box, width, height) {
  return validBox(box, width, height) && box.left > 0 && box.top > 0
    && box.left + box.width < width && box.top + box.height < height;
}

export function safeCropForSubject({ width, height, subjectBox, aspectRatio, margin = 0.08, safeInset = 0, balanced = true }) {
  if (![width, height, aspectRatio].every(Number.isFinite) || width < 1 || height < 1 || aspectRatio <= 0
    || !validBox(subjectBox, width, height) || !Number.isFinite(margin) || margin < 0 || margin > 0.25
    || !Number.isInteger(safeInset) || safeInset < 0 || safeInset * 2 >= Math.min(width, height)) return null;
  const usableWidth = width - safeInset * 2, usableHeight = height - safeInset * 2;
  let cropWidth = Math.min(usableWidth, usableHeight * aspectRatio);
  let cropHeight = cropWidth / aspectRatio;
  // Integer dimensions must preserve an exact 1:1 or 3:2 output ratio.
  if (aspectRatio === 1) cropWidth = cropHeight = Math.floor(Math.min(usableWidth, usableHeight));
  else if (aspectRatio === 1.5) {
    const unit = Math.floor(Math.min(usableWidth / 3, usableHeight / 2));
    cropWidth = unit * 3; cropHeight = unit * 2;
  } else if (aspectRatio === 2 / 3) {
    const unit = Math.floor(Math.min(usableWidth / 2, usableHeight / 3));
    cropWidth = unit * 2; cropHeight = unit * 3;
  } else return null;
  // Keep room around whole views, without retaining all the empty studio floor.
  // Limit the automatic zoom to 22%: a detector can miss a pale seat or thin leg.
  if (balanced) {
    const wantedHeight=Math.max(subjectBox.height/0.68,subjectBox.width/(aspectRatio*0.74),cropHeight*0.78);
    const unit=aspectRatio===1?1:aspectRatio===1.5?2:3;
    cropHeight=Math.min(cropHeight,Math.ceil(wantedHeight/unit)*unit);
    cropWidth=cropHeight*aspectRatio;
  }
  if (cropWidth < 1 || cropHeight < 1) return null;
  const usableRight = width - safeInset, usableBottom = height - safeInset;
  if (subjectBox.left < safeInset || subjectBox.top < safeInset
    || subjectBox.left + subjectBox.width > usableRight || subjectBox.top + subjectBox.height > usableBottom) return null;
  const padding = Math.ceil(Math.min(width, height) * margin);
  // Margin is breathing room inside the photo. Where the product already runs
  // to the frame edge there is none to keep, and demanding it there only
  // pushes a correctly centred product out of square into a wider ratio.
  const wantedLeft = Math.max(safeInset, subjectBox.left - padding);
  const wantedTop = Math.max(safeInset, subjectBox.top - padding);
  const wantedRight = Math.min(usableRight, subjectBox.left + subjectBox.width + padding);
  const wantedBottom = Math.min(usableBottom, subjectBox.top + subjectBox.height + padding);
  if (wantedRight - wantedLeft > cropWidth || wantedBottom - wantedTop > cropHeight) return null;
  const centerX = subjectBox.left + subjectBox.width / 2;
  const centerY = subjectBox.top + subjectBox.height / 2;
  const left = Math.round(Math.max(safeInset,wantedRight-cropWidth,Math.min(wantedLeft,width-safeInset-cropWidth,centerX-cropWidth/2)));
  // Human whole views leave more air above the object than below it.
  const top = Math.round(Math.max(safeInset,wantedBottom-cropHeight,Math.min(wantedTop,height-safeInset-cropHeight,centerY-cropHeight*0.58)));
  if (left > wantedLeft || top > wantedTop || left + cropWidth < wantedRight || top + cropHeight < wantedBottom) return null;
  return { left, top, width: cropWidth, height: cropHeight };
}

/** Detail views intentionally run off the frame. Centre the visible detail
 * only when both sides were verified; a partial whole-subject box is not a
 * focus point. Otherwise retain the photograph's centre, with no added bands. */
export function detailCrop({width,height,aspectRatio,safeInset=0,detailFocus}) {
  if(![width,height,aspectRatio].every(n=>Number.isFinite(n)&&n>0))return null;
  if(!Number.isInteger(safeInset)||safeInset<0||safeInset*2>=Math.min(width,height))return null;
  const aw=width-safeInset*2,ah=height-safeInset*2;
  const unit=aspectRatio===1?Math.floor(Math.min(aw,ah)):aspectRatio===1.5?Math.floor(Math.min(aw/3,ah/2)):0;
  if(!unit)return null;
  const w=unit*(aspectRatio===1?1:3),h=unit*(aspectRatio===1?1:2);
  const x=Number.isFinite(detailFocus?.x)&&detailFocus.x>=.30&&detailFocus.x<=.70?width*detailFocus.x:width/2;
  return {left:Math.round(Math.max(safeInset,Math.min(width-safeInset-w,x-w/2))),top:Math.round((height-h)/2),width:w,height:h};
}

export function photoSequence(name='') {
  const circled=[...name].map(c=>'①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'.indexOf(c)+1).find(n=>n>0);
  return circled??null;
}

/** Filename order is a hint only. Full subjects recognized by the detector
 * always stay whole views. Explicit staff choices override that classification. */
export function framingIntent({fileName,isMain,detection,override}) {
  if(override==='detail'||override==='whole')return override;
  if(isMain||detection?.status==='READY')return 'whole';
  // Later numbered views were deliberately shot close-up in the established workflow.
  // Keep unknown unnumbered and first three views conservative and reviewable.
  return (photoSequence(fileName)??0)>3?'detail':'whole';
}

/** A grouped studio shoot can inherit the verified top photo's horizontal
 * centre. Keep the complete image height; only remove symmetric side space.
 * Do not use this for panoramic/portrait photos or an off-centre top photo. */
export function squareCropFromTopAnchor({ width, height, topCentreFraction }) {
  if (![width, height, topCentreFraction].every(Number.isFinite) || width < height || width / height > 1.85
    || topCentreFraction < 0.35 || topCentreFraction > 0.65) return null;
  const side = Math.floor(height);
  const left = Math.round(Math.max(0, Math.min(width - side, width * topCentreFraction - side / 2)));
  return { left, top: 0, width: side, height: side };
}

export function planProductFraming({ topAssetId, images }) {
  if (!topAssetId || !Array.isArray(images) || images.length === 0) throw new Error('商品とトップ画像を指定してください');
  const top = images.find(image => image.assetId === topAssetId);
  if (!top || images.some(image => !image.assetId || !Number.isFinite(image.width) || !Number.isFinite(image.height)))
    throw new Error('写真のサイズを確認できません');
  // Only the main photo determines the ratio. Uncertainty is not evidence
  // that the main subject needs a wide canvas. Every photo fills the chosen ratio.
  const knownTop = validBox(top.subjectBox, top.width, top.height);
  const aspectRatio = knownTop && top.framingMode!=='detail' && !safeCropForSubject({ ...top, aspectRatio: 1, balanced:false, margin:0.10 }) ? 1.5 : 1;
  const crops = Object.fromEntries(images.map(image => [image.assetId,
    image.framingMode==='detail'?detailCrop({...image,aspectRatio}):
      safeCropForSubject({ ...image, aspectRatio }) ?? detailCrop({...image,aspectRatio})]));
  return { status: 'READY', aspectRatio, crops, topAssetId,
    containAssetIds: [] };
}

/** Render the selected Lightroom recipe, then level/detect every image before upload. */
export async function prepareProductFraming({ sources, topFileName, selectedPresets, outputRoot, render,
  stationRoot, settings, overrides = {}, detect = analyzeStudioPhoto, level = estimateStudioLevel,
  detectDetail = analyzeDetailFocus }) {
  const top = sources.find(source => source.fileName === topFileName);
  if (!top) throw new Error('トップ画像が取込済み写真にありません');
  if (!selectedPresets || sources.some(source => !selectedPresets.has(source.fileName)))
    throw new Error('全写真のLightroomプリセットを確定してください');
  let touch=null;
  try { touch=JSON.parse(await readFile(path.join(outputRoot,'touch-framing.json'),'utf8')); }
  catch(e) { if(e.code!=='ENOENT')throw e; }
  if(touch) {
    if(touch.version!==1||touch.completed!==true||![1,1.5].includes(touch.aspectRatio))
      return {status:'NEEDS_REVIEW',reason:'位置調整が途中です。全写真を確認して「完了」を押してください'};
    const frames=new Map(),crops={};
    for(const source of sources) {
      const item=touch.items?.[source.fileName];
      const hash=await sha256File(source.sourcePath);
      if(!item||item.sourceHash!==hash)return {status:'NEEDS_REVIEW',reason:source.fileName+'：元画像が変わりました。位置を確認し直してください'};
      const choice=selectedPresets.get(source.fileName);
      const rendered=await renderCachedLightroom({root:stationRoot,sourcePath:source.sourcePath,preset:choice.preset,
        expectedSignature:choice.signature,longEdgePx:settings.longEdgePx,jpegQuality:100,preserveFraming:true,
        cacheDir:path.join(outputRoot,'comparisons','render-cache')},render);
      const m=await sharp(imagePath(rendered.path)).metadata();
      if(Math.abs(m.width/m.height-item.width/item.height)>0.005)
        return {status:'NEEDS_REVIEW',reason:source.fileName+'：現像後の縦横比が変わっています。Lightroom連携を更新してください'};
      crops[source.clientAssetId]=touchCrop({...item,width:m.width,height:m.height,aspectRatio:touch.aspectRatio});
      // Detection is for stamp collision avoidance only. It cannot alter the user's crop.
      const detected=source.clientAssetId===top.clientAssetId?await detect(rendered.path):null;
      frames.set(source.clientAssetId,{path:rendered.path,width:m.width,height:m.height,angle:0,sourceHash:hash,subjectBox:detected?.status==='READY'?detected.subjectBox:null});
    }
    const confirmationHash=createHash('sha256').update(JSON.stringify({version:'touch-1',touch,crops,top:top.clientAssetId,
      presets:[...selectedPresets].map(([name,value])=>[name,value.preset.hash])})).digest('hex');
    return {status:'READY',aspectRatio:touch.aspectRatio,topAssetId:top.clientAssetId,crops,frames,confirmationHash};
  }
  const directory = path.join(outputRoot, 'framing');
  await mkdir(directory, { recursive: true });
  const frames = new Map(), images = [], uncertain = [];
  for (const source of sources) {
    const override = overrides[source.fileName];
    const choice = selectedPresets.get(source.fileName);
    const rendered = await renderCachedLightroom({ root: stationRoot, sourcePath: source.sourcePath, preset: choice.preset,
      expectedSignature: choice.signature, longEdgePx: settings.longEdgePx, jpegQuality: 100,
      cacheDir: path.join(outputRoot, 'comparisons', 'render-cache') }, render);
    const sourceHash = rendered.sourceHash ?? await sha256File(source.sourcePath);
    if (override && override.sourceHash !== sourceHash)
      return { status: 'NEEDS_REVIEW', reason: `${source.fileName}：元画像が変わりました。構図を指定し直してください` };
    const levelResult = override && Number.isFinite(override.angle) ? { status: 'READY', angle: override.angle } : await level(rendered.path);
    // If the horizon is uncertain, keep the original orientation. Guessing a
    // rotation is more destructive than leaving a photo slightly unlevel.
    const levelKnown = levelResult.status === 'READY' && Number.isFinite(levelResult.angle) && Math.abs(levelResult.angle) <= 5;
    const angle = levelKnown ? levelResult.angle : 0;
    // Most studio photos are already level. Reuse Lightroom's verified JPEG
    // instead of re-encoding the full image before detection and final crop.
    const leveledPath = Math.abs(angle) < 0.01 ? rendered.path : path.join(directory, `${source.clientAssetId}.jpg`);
    if (leveledPath !== rendered.path)
      await sharp(imagePath(rendered.path)).rotate(angle, { background: '#eeeeee' }).jpeg({ quality: 100 }).toFile(imagePath(leveledPath));
    let detected = override?.subjectBox ? { status: 'READY', ...await sharp(imagePath(leveledPath)).metadata(), subjectBox: override.subjectBox } : await detect(leveledPath);
    if (!override && detected.status !== 'READY' && Math.abs(angle) < 0.01)
      detected = await recoverSourceFraming(source.sourcePath, rendered.path) ?? detected;
    if (override && ((override.framingMode!=='detail'&&!validBox(override.subjectBox, detected.width, detected.height))
      || !Number.isFinite(override.angle) || Math.abs(override.angle) > 5))
      return { status: 'NEEDS_REVIEW', reason: `${source.fileName}：指定した商品範囲または傾きが不正です。構図を指定し直してください` };
    // An unmeasurable horizon only rules out rotating. The photo is then left
    // as shot, so a verified subject box still crops safely — and far more
    // safely than inheriting another photo's centre without one.
    // The edge test is repeated here on the detector's own output: this stage
    // is what turns a box into a destructive crop, so it does not assume the
    // detector it was handed applied any gate of its own.
    const canCrop = detected.status === 'READY' && (Boolean(override?.subjectBox)
      || detectedBoxIsUsable(detected.subjectBox, detected.width, detected.height));
    const framingMode=framingIntent({fileName:source.fileName,isMain:source.clientAssetId===top.clientAssetId,detection:detected,override:override?.framingMode});
    if (canCrop) {
      const safeInset = Math.abs(angle) < 0.01 ? 0
        : Math.ceil(Math.max(detected.width, detected.height) * Math.abs(Math.sin(angle * Math.PI / 180))) + 4;
      images.push({ assetId: source.clientAssetId, ...detected, safeInset, framingMode,
        detailFocus: await detectDetail(leveledPath) });
    } else {
      const metadata = await sharp(imagePath(rendered.path)).metadata();
      uncertain.push({ assetId: source.clientAssetId, width: metadata.width, height: metadata.height, framingMode,
        detailFocus: await detectDetail(rendered.path) });
    }
    // A full-frame fallback cannot crop away the pale rotation corners.
    // Keep the unrotated Lightroom result in that case.
    const frameMetadata = await sharp(imagePath(canCrop ? leveledPath : rendered.path)).metadata();
    frames.set(source.clientAssetId, { path: canCrop ? leveledPath : rendered.path,
      angle: canCrop ? angle : 0, sourceHash,
      width: frameMetadata.width, height: frameMetadata.height,
      subjectBox: canCrop ? detected.subjectBox : null });
  }
  const plan = planProductFraming({ topAssetId: top.clientAssetId, images: [...images, ...uncertain] });
  const identity = await Promise.all(sources.map(async source => ({
    id: source.clientAssetId, original: frames.get(source.clientAssetId).sourceHash,
    preset: selectedPresets.get(source.fileName).preset.hash,
    crop: plan.crops[source.clientAssetId], angle: frames.get(source.clientAssetId).angle,
    subjectBox: frames.get(source.clientAssetId).subjectBox, framingMode:overrides[source.fileName]?.framingMode??'auto',
  })));
  const stampHash = await sha256File(fileURLToPath(new URL('../assets/BelloStamp.png', import.meta.url)));
  const confirmationHash = createHash('sha256').update(JSON.stringify({ topAssetId: top.clientAssetId,
    aspectRatio: plan.aspectRatio, identity, stampHash, layoutVersion: 6 })).digest('hex');
  return { ...plan, frames, confirmationHash };
}
