import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

export function touchCrop({ width, height, aspectRatio, centerX, centerY, zoom }) {
  if (![width,height,centerX,centerY,zoom].every(Number.isFinite) || width < 1 || height < 1 ||
      ![1,1.5].includes(aspectRatio) || centerX < 0 || centerX > 1 || centerY < 0 || centerY > 1 || zoom < 1 || zoom > 4)
    throw new Error('構図の位置または倍率が不正です。位置を確認し直してください');
  const units = Math.floor(Math.min(width/(aspectRatio===1?1:3),height/(aspectRatio===1?1:2))/zoom);
  if (units < 1) throw new Error('切り抜き範囲が小さすぎます');
  const w=units*(aspectRatio===1?1:3),h=units*(aspectRatio===1?1:2);
  return {left:Math.round(Math.max(0,Math.min(width-w,centerX*width-w/2))),
    top:Math.round(Math.max(0,Math.min(height-h,centerY*height-h/2))),width:w,height:h};
}

// Raw files may have an embedded camera JPEG even without a Windows RAW codec.
export async function sourcePreviewBytes(bytes, fileName) {
  if (!/\.arw$/i.test(fileName)) return bytes;
  let best=null,area=0;
  for(let i=0;i<bytes.length-3;i++) {
    if(bytes[i]!==255||bytes[i+1]!==216||bytes[i+2]!==255)continue;
    const end=bytes.indexOf(Buffer.from([255,217]),i+3); if(end<0)break;
    if(end-i<16384)continue;
    const candidate=bytes.subarray(i,end+2);
    try { const m=await sharp(candidate).metadata();if(m.width*m.height>area){best=candidate;area=m.width*m.height;} } catch {}
  }
  if(!best)throw new Error('このRAWのプレビューを読み込めません。カメラで同時保存したJPEGを選択してください');
  return best;
}

export async function makeTouchPreview(source, sessionRoot) {
  const bytes=await fs.readFile(source.sourcePath);
  const sourceHash=createHash('sha256').update(bytes).digest('hex');
  const preview=await sourcePreviewBytes(bytes,source.fileName);
  const m=await sharp(preview).metadata();
  const width=m.autoOrient?.width??m.width,height=m.autoOrient?.height??m.height;
  const dir=path.join(sessionRoot,'touch-previews');await fs.mkdir(dir,{recursive:true});
  const file=path.join(dir,sourceHash+'.jpg');
  try { await fs.access(file); }
  catch { await fs.writeFile(file,await sharp(preview).rotate().resize(1280,1280,{fit:'inside',withoutEnlargement:true}).jpeg({quality:85}).toBuffer()); }
  return {fileName:source.fileName,path:file,width,height,sourceHash};
}
