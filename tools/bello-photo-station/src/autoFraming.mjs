import { imagePath } from './imagePath.mjs';
import sharp from 'sharp';
import {neutralPanelSubject} from './neutralPanel.mjs';

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

export async function estimateStudioLevel(file) {
  const { data, info } = await sharp(imagePath(file)).rotate().resize({ width: 512, withoutEnlargement: true })
    .greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  if (width < 80 || height < 80) return { status: 'NEEDS_REVIEW', angle: 0 };
  const collect = (from, to) => {
    const points = [];
    for (let x = Math.floor(width * from); x < Math.floor(width * to); x += 2) {
      let best = { score: 0, y: 0 };
      for (let y = Math.floor(height * 0.35); y < Math.floor(height * 0.78); y++) {
        const score = Math.abs(data[(y + 2) * width + x] - data[(y - 2) * width + x]);
        if (score > best.score) best = { score, y };
      }
      if (best.score >= 25) points.push(best.y);
    }
    const y = median(points);
    if (y == null || points.length < (to - from) * width / 8
      || median(points.map(point => Math.abs(point - y))) > height * 0.018) return null;
    return y;
  };
  const left = collect(0.06, 0.28), right = collect(0.72, 0.94);
  if (left == null || right == null || Math.abs(right - left) > height * 0.10)
    return { status: 'NEEDS_REVIEW', angle: 0 };
  const angle = -Math.atan2(right - left, width * 0.66) * 180 / Math.PI;
  return { status: 'READY', angle: Math.abs(angle) < 0.15 ? 0 : Number(angle.toFixed(2)) };
}

// A frame with less colour than this is handled by the neutral path below:
// white goods on a grey wall carry no chroma for the contrast path to use.
const NEUTRAL_CHROMA = 24;
const NEUTRAL_SCENE_SHARE = 0.015;
// Half-widths to look across. The widest must clear half the subject, the
// narrowest must stay inside one background region.
const NEUTRAL_SPANS = [0.14, 0.20, 0.26];
const NEUTRAL_MARGIN = 30;
const NEUTRAL_PLATEAU = 14;
const NEUTRAL_MIN_PART = 0.0015;
// What the real table photos failed: their plateaus ran the full height of the
// frame with the box top at 0, yet stayed inside the horizontal limits and so
// were returned as subjects. A product photographed on a table is surrounded
// by the background it is measured against, so a candidate that reaches the
// border, spans most of an axis, or leaves its own box half empty is the room.
const NEUTRAL_MAX_WIDTH = 0.55;
const NEUTRAL_MAX_HEIGHT = 0.72;
const NEUTRAL_MIN_FILL = 0.45;

/** Every rejection carries the same phrase, so callers can match on it, plus
 * the detail the manual framing run needs to see which gate stopped a photo. */
const unsure = detail => ({ reject: `被写体を安全に特定できません（${detail}）` });

/**
 * True when a box reaches the frame border, measured with the same inset the
 * background baselines are read from, on all four sides. A region running off
 * the frame has no visible outline there, so its extent is a guess: the part
 * of it outside the photo is unknown and can be any size. Such a box is never
 * evidence of a product, however plausible its remaining edges look.
 */
function touchesFrame(box, { width, height, band, bandY }) {
  return box.left <= band || box.right >= width - band - 1
    || box.top <= bandY || box.bottom >= height - bandY - 1;
}

/** Connected 4-neighbour runs of a boolean mask, each with its pixels and box. */
function components(mask, width, height) {
  const seen = new Uint8Array(mask.length), found = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const pixels = [start]; seen[start] = 1;
    let head = 0, left = width, top = height, right = 0, bottom = 0;
    while (head < pixels.length) {
      const index = pixels[head++], x = index % width, y = Math.floor(index / width);
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      for (const next of [x > 0 ? index - 1 : -1, x + 1 < width ? index + 1 : -1,
        y > 0 ? index - width : -1, y + 1 < height ? index + width : -1]) {
        if (next >= 0 && mask[next] && !seen[next]) { seen[next] = 1; pixels.push(next); }
      }
    }
    found.push({ size: pixels.length, pixels, left, top, right, bottom });
  }
  return found;
}

/** Original path: the subject differs in colour from its own row's background. */
function contrastSubject({ at, width, height, band, bandY }) {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const left = [0, 1, 2].map(c => median(Array.from({ length: band }, (_, i) => at(i, y, c))));
    const right = [0, 1, 2].map(c => median(Array.from({ length: band }, (_, i) => at(width - 1 - i, y, c))));
    for (let x = band; x < width - band; x++) {
      const t = x / (width - 1);
      const difference = [0, 1, 2].reduce((sum, c) => sum + Math.abs(at(x, y, c) - (left[c] * (1 - t) + right[c] * t)), 0) / 3;
      const rgb = [at(x, y, 0), at(x, y, 1), at(x, y, 2)];
      const chroma = Math.max(...rgb) - Math.min(...rgb);
      // A neutral vignette can differ greatly from the row-edge baseline;
      // chroma prevents treating the entire bright wall/floor as an object.
      if (difference > 22 && chroma > 11) mask[y * width + x] = 1;
    }
  }
  let best = null;
  for (const part of components(mask, width, height)) if (!best || part.size > best.size) best = part;
  if (!best) return unsure('候補が見つかりません');
  if (best.size < width * height * 0.012) return unsure('候補が小さすぎます');
  if (best.size > width * height * 0.55) return unsure('候補が画面の大半を占めます');
  if (touchesFrame(best, { width, height, band, bandY })) return unsure('候補が画像の端に接しています');
  const centre = (best.left + best.right) / (2 * width);
  if (centre < 0.22 || centre > 0.78) return unsure('候補が中央から外れています');
  return { box: best, size: best.size, subjectSource: 'contrast' };
}

/**
 * Neutral path. A product standing clear of its background is brighter than
 * that background on BOTH sides at the same height. A lighting vignette or a
 * wall/floor step runs monotonically across a row, so it can never be brighter
 * than both of its own neighbours at the same distance — which is exactly why
 * the chroma gate was needed before, and why it is no longer.
 */
function neutralSubject({ luma, width, height, band, bandY }) {
  const total = width * height;
  // Median of a short window, so JPEG noise and a floor scratch cannot seed.
  const smooth = new Float32Array(total);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      smooth[y * width + x] = median(Array.from({ length: 5 },
        (_, i) => luma[y * width + Math.min(width - 1, Math.max(0, x + (i - 2) * 2))]));
    }
  }
  const spans = NEUTRAL_SPANS.map(fraction => Math.round(width * fraction));
  const seeds = new Uint8Array(total);
  for (let y = 0; y < height; y++) {
    for (let x = band; x < width - band; x++) {
      const value = luma[y * width + x];
      for (const span of spans) {
        if (x - span < 0 || x + span >= width) continue;
        if (value - smooth[y * width + x - span] >= NEUTRAL_MARGIN
          && value - smooth[y * width + x + span] >= NEUTRAL_MARGIN) { seeds[y * width + x] = 1; break; }
      }
    }
  }
  // Only the centre of a wide subject can see background on both sides, so a
  // seed marks the subject without measuring it. Grow each seed over its own
  // even-toned plateau to recover the real extent before any crop is planned.
  const taken = new Uint8Array(total);
  const parts = [];
  for (const seed of components(seeds, width, height)) {
    if (seed.pixels.every(index => taken[index])) continue;
    const reference = median(seed.pixels.map(index => luma[index]));
    const queue = seed.pixels.filter(index => !taken[index]);
    for (const index of queue) taken[index] = 1;
    let head = 0, left = width, top = height, right = 0, bottom = 0;
    while (head < queue.length) {
      const index = queue[head++], x = index % width, y = Math.floor(index / width);
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      for (const next of [x > 0 ? index - 1 : -1, x + 1 < width ? index + 1 : -1,
        y > 0 ? index - width : -1, y + 1 < height ? index + width : -1]) {
        if (next >= 0 && !taken[next] && Math.abs(luma[next] - reference) <= NEUTRAL_PLATEAU) {
          taken[next] = 1; queue.push(next);
        }
      }
    }
    parts.push({ size: queue.length, reference, left, top, right, bottom });
  }
  const kept = parts.filter(part => part.size >= total * NEUTRAL_MIN_PART);
  if (!kept.length) return unsure('候補が見つかりません');
  // A plateau that ran into the frame edge or swallowed the room means the
  // model was wrong for this photo. Hand it back rather than crop on it. This
  // is checked per plateau and before merging, so one runaway part cannot be
  // averaged out by well-behaved neighbours.
  if (kept.some(part => part.size > total * 0.55)) return unsure('候補が画面の大半を占めます');
  if (kept.some(part => touchesFrame(part, { width, height, band, bandY })))
    return unsure('候補が画像の端に接しています');
  const box = {
    left: Math.min(...kept.map(part => part.left)), right: Math.max(...kept.map(part => part.right)),
    top: Math.min(...kept.map(part => part.top)), bottom: Math.max(...kept.map(part => part.bottom)),
  };
  const size = kept.reduce((sum, part) => sum + part.size, 0);
  const boxWidth = box.right - box.left + 1, boxHeight = box.bottom - box.top + 1;
  const centre = (box.left + box.right) / (2 * width);
  // Tighter than the contrast path: brightness alone is weaker evidence, so a
  // wide, tall, hollow or off-centre neutral blob is never trusted enough to
  // crop against. The height limit is the one the table photos needed.
  if (size < total * 0.012) return unsure('候補が小さすぎます');
  if (boxWidth > width * NEUTRAL_MAX_WIDTH) return unsure('候補が横に広すぎます');
  if (boxHeight > height * NEUTRAL_MAX_HEIGHT) return unsure('候補が縦に長すぎます');
  if (size < boxWidth * boxHeight * NEUTRAL_MIN_FILL) return unsure('候補の内部が埋まっていません');
  if (centre < 0.30 || centre > 0.70) return unsure('候補が中央から外れています');
  if (touchesFrame(box, { width, height, band, bandY })) return unsure('候補が画像の端に接しています');
  // Last, the claim itself: the plateau must be brighter than the background
  // ringing the whole candidate, not merely brighter than two sample points on
  // its own row. A bright patch of floor is level with the floor around it.
  const pad = Math.max(2, Math.round(Math.min(width, height) * 0.02));
  const ring = [];
  for (let y = Math.max(0, box.top - pad); y <= Math.min(height - 1, box.bottom + pad); y++) {
    for (let x = Math.max(0, box.left - pad); x <= Math.min(width - 1, box.right + pad); x++) {
      if (x < box.left || x > box.right || y < box.top || y > box.bottom) ring.push(luma[y * width + x]);
    }
  }
  if (!ring.length || median(kept.map(part => part.reference)) - median(ring) < NEUTRAL_MARGIN)
    return unsure('背景との明るさの差が足りません');
  return { box, size, subjectSource: 'neutral' };
}

// Black and wooden furniture can disappear from the colour-only mask, while
// coloured shadows at the sides get mistaken for the subject. Measure a dark
// object against neighbours on BOTH sides; a lighting gradient cannot pass.
function darkSubject({ luma, width, height, band, bandY }) {
  const mask = new Uint8Array(width * height);
  const spans = [0.14, 0.20, 0.26, 0.34].map(v => Math.round(v * width));
  for (let y = 0; y < height; y++) for (let x = band; x < width - band; x++) {
    const v = luma[y * width + x];
    if (spans.some(s => x - s >= 0 && x + s < width
      && luma[y * width + x - s] - v > 28 && luma[y * width + x + s] - v > 28)) mask[y * width + x] = 1;
  }
  const parts = components(mask, width, height).filter(p => p.size >= width * height * 0.002);
  if (!parts.length || parts.some(p => touchesFrame(p, { width, height, band, bandY }))) return null;
  const box = { left: Math.min(...parts.map(p => p.left)), right: Math.max(...parts.map(p => p.right)),
    top: Math.min(...parts.map(p => p.top)), bottom: Math.max(...parts.map(p => p.bottom)) };
  const size = parts.reduce((s, p) => s + p.size, 0), centre = (box.left + box.right) / (2 * width);
  if (size < width * height * 0.012 || centre < 0.25 || centre > 0.75
    || box.right - box.left > width * 0.72 || box.bottom - box.top > height * 0.85) return null;
  // Include the anti-aliased outline and thin legs at the mask boundary.
  const pad = Math.ceil(Math.min(width, height) * 0.015);
  box.left -= pad; box.right += pad; box.top -= pad; box.bottom += pad;
  if (touchesFrame(box, { width, height, band, bandY })) return null;
  return { box, size, subjectSource: 'dark' };
}

/** A lit shade can stand in front of a coloured wall. Accept only an enclosed,
 * compact brightness peak; room edges and lighting gradients remain rejected. */
function isolatedLightSubject({luma,width,height,band,bandY}) {
  const mask=new Uint8Array(width*height), span=Math.round(width*.25);
  for(let y=0;y<height;y++) for(let x=span;x<width-span;x++) {
    const value=luma[y*width+x];
    if(value>175 && value-luma[y*width+x-span]>55 && value-luma[y*width+x+span]>55) mask[y*width+x]=1;
  }
  const parts=components(mask,width,height).filter(p=>p.size>width*height*.015);
  if(parts.length!==1) return null;
  const box=parts[0],fill=box.size/((box.right-box.left+1)*(box.bottom-box.top+1));
  const cx=(box.left+box.right)/(2*width),cy=(box.top+box.bottom)/(2*height);
  if(touchesFrame(box,{width,height,band,bandY})||fill<.5||cx<.35||cx>.65||cy<.25||cy>.75
    ||box.right-box.left>width*.45||box.bottom-box.top>height*.6) return null;
  // Retain a generous area above a shade for its fitting/loop. The planner's
  // bounded zoom also keeps the photographed context around that upper edge.
  const pad=Math.ceil(Math.min(width,height)*.025);
  const expanded={left:box.left-pad,right:box.right+pad,top:box.top-pad*3,bottom:box.bottom+pad};
  if(touchesFrame(expanded,{width,height,band,bandY})) return null;
  return {box:expanded,size:box.size,subjectSource:'isolated-light'};
}

// A strongly coloured object can be separated from a tinted wall even when
// the ordinary row contrast mistakes the room for the largest component.
// Only one enclosed colour mass is accepted; multiple objects and edge crops
// stay in review. This fallback is never used to tighten an existing detection.
function isolatedColourSubject({at,width,height,band,bandY}) {
  const mask=new Uint8Array(width*height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const values=[at(x,y,0),at(x,y,1),at(x,y,2)],max=Math.max(...values),min=Math.min(...values);
    if(max-min>65&&(max-min)/Math.max(1,max)>.55)mask[y*width+x]=1;
  }
  const parts=components(mask,width,height).filter(p=>p.size>width*height*.002).sort((a,b)=>b.size-a.size);
  if(!parts.length)return null;
  const box=parts[0],total=width*height;
  if(box.size<total*.015||parts.slice(1).some(p=>p.size>box.size*.15)
    ||touchesFrame(box,{width,height,band,bandY}))return null;
  const boxWidth=box.right-box.left+1,boxHeight=box.bottom-box.top+1,cx=(box.left+box.right)/(2*width);
  if(cx<.30||cx>.70||boxWidth>width*.5||boxHeight>height*.65
    ||box.size/(boxWidth*boxHeight)<.35)return null;
  const pad=Math.ceil(Math.min(width,height)*.025);
  const expanded={left:box.left-pad,right:box.right+pad,top:box.top-pad*3,bottom:box.bottom+pad};
  if(touchesFrame(expanded,{width,height,band,bandY}))return null;
  return {box:expanded,size:box.size,subjectSource:'isolated-colour'};
}

/** Conservative studio-photo analysis. Failure means full-photo fit, never a blind crop. */
export async function analyzeStudioPhoto(file) {
  const { data, info } = await sharp(imagePath(file)).rotate().resize({ width: 384, withoutEnlargement: true })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  if (width < 80 || height < 80 || channels < 3) return { status: 'NEEDS_REVIEW', reason: '画像が小さすぎます' };
  const source = await sharp(imagePath(file)).metadata();
  const sourceWidth = source.autoOrient?.width ?? source.width;
  const sourceHeight = source.autoOrient?.height ?? source.height;
  const at = (x, y, c) => data[(y * width + x) * channels + c];
  const band = Math.max(3, Math.floor(width * 0.08));
  const bandY = Math.max(3, Math.floor(height * 0.08));
  const total = width * height;
  const luma = new Float32Array(total);
  let colourful = 0;
  for (let index = 0; index < total; index++) {
    const [r, g, b] = [0, 1, 2].map(c => data[index * channels + c]);
    luma[index] = (r * 299 + g * 587 + b * 114) / 1000;
    if (Math.max(r, g, b) - Math.min(r, g, b) > NEUTRAL_CHROMA) colourful++;
  }
  // The two paths are exclusive: where there is colour to separate the subject
  // by, use it; a neutral frame is the only case brightness has to stand alone.
  let found = colourful < total * NEUTRAL_SCENE_SHARE
    ? neutralSubject({ luma, width, height, band, bandY })
    : contrastSubject({ at, width, height, band, bandY });
  const dark = darkSubject({ luma, width, height, band, bandY });
  if (dark && found.reject) found = dark;
  else if (dark && !found.reject) {
    // A coloured seat alone must not crop away a black backrest or legs.
    found.box = { left: Math.min(found.box.left, dark.box.left), top: Math.min(found.box.top, dark.box.top),
      right: Math.max(found.box.right, dark.box.right), bottom: Math.max(found.box.bottom, dark.box.bottom) };
  }
  if(found.reject && colourful>=total*NEUTRAL_SCENE_SHARE) found=isolatedLightSubject({luma,width,height,band,bandY})??found;
  if(found.reject && colourful>=total*NEUTRAL_SCENE_SHARE) found=isolatedColourSubject({at,width,height,band,bandY})??found;
  if(found.reject && colourful<total*NEUTRAL_SCENE_SHARE) found=neutralPanelSubject({luma,width,height,band,bandY,components})??found;
  if (found.reject) return { status: 'NEEDS_REVIEW', reason: found.reject };
  const { box, size, subjectSource } = found;
  const subjectBox = {
    left: Math.max(0, Math.floor(box.left * sourceWidth / width)),
    top: Math.max(0, Math.floor(box.top * sourceHeight / height)),
    width: Math.min(sourceWidth, Math.ceil((box.right - box.left + 1) * sourceWidth / width)),
    height: Math.min(sourceHeight, Math.ceil((box.bottom - box.top + 1) * sourceHeight / height)),
  };
  // One last check on the value actually returned, in source pixels and
  // independent of which path produced it: a detected box that reaches any
  // frame edge is the room, not the product, whatever the internals concluded.
  if (subjectBox.left <= 0 || subjectBox.top <= 0
    || subjectBox.left + subjectBox.width >= sourceWidth
    || subjectBox.top + subjectBox.height >= sourceHeight)
    return { status: 'NEEDS_REVIEW', reason: unsure('候補が画像の端に接しています').reject };
  return { status: 'READY', width: sourceWidth, height: sourceHeight, subjectBox, subjectSource,
    subjectConfidence: Math.min(1, size / (total * 0.08)) };
}
