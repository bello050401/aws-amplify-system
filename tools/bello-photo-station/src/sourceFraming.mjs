import { imagePath } from './imagePath.mjs';
import sharp from 'sharp';
import { analyzeStudioPhoto } from './autoFraming.mjs';

// Tone correction can erase a white object's boundary against a white wall.
// Reuse the original's outline only when edges still occupy the same positions
// in BOTH the whole photograph and the subject area. Equal aspect ratios alone
// are insufficient: a preset may crop, mirror or correct perspective.
export async function recoverSourceFraming(sourcePath, renderedPath) {
  try {
    const original = await analyzeStudioPhoto(sourcePath);
    if (original.status !== 'READY') return null;
    const metadata = await sharp(imagePath(renderedPath)).metadata();
    const width = metadata.autoOrient?.width ?? metadata.width;
    const height = metadata.autoOrient?.height ?? metadata.height;
    if (!width || !height || Math.abs(width / height - original.width / original.height) > 0.002) return null;
    const sampleWidth = 384, sampleHeight = Math.round(sampleWidth * original.height / original.width);
    const sample = file => sharp(imagePath(file)).rotate().resize(sampleWidth, sampleHeight, { fit: 'fill' })
      .greyscale().blur(1).raw().toBuffer();
    const [before, after] = await Promise.all([sample(sourcePath), sample(renderedPath)]);
    const box = original.subjectBox;
    const whole = { dot: 0, before: 0, after: 0, count: 0 };
    const subject = { ...whole };
    for (let y = 1; y < sampleHeight - 1; y++) for (let x = 1; x < sampleWidth - 1; x++) {
      const i = y * sampleWidth + x;
      const ax = before[i + 1] - before[i - 1], ay = before[i + sampleWidth] - before[i - sampleWidth];
      const bx = after[i + 1] - after[i - 1], by = after[i + sampleWidth] - after[i - sampleWidth];
      const inside = x >= box.left * sampleWidth / original.width && x <= (box.left + box.width) * sampleWidth / original.width
        && y >= box.top * sampleHeight / original.height && y <= (box.top + box.height) * sampleHeight / original.height;
      for (const area of inside ? [whole, subject] : [whole]) {
        area.dot += ax * bx + ay * by;
        area.before += ax * ax + ay * ay;
        area.after += bx * bx + by * by;
        area.count++;
      }
    }
    const correlation = area => area.before > area.count && area.after > area.count
      ? area.dot / Math.sqrt(area.before * area.after) : 0;
    const alignment = { whole: correlation(whole), subject: correlation(subject) };
    if (alignment.whole < 0.94 || alignment.subject < 0.94) return null;
    const left = Math.floor(box.left * width / original.width), top = Math.floor(box.top * height / original.height);
    const right = Math.ceil((box.left + box.width) * width / original.width);
    const bottom = Math.ceil((box.top + box.height) * height / original.height);
    return { status: 'READY', width, height, subjectBox: { left, top, width: right - left, height: bottom - top },
      subjectSource: 'source-verified', alignment };
  } catch {
    // Unsupported camera RAWs or unverified geometry retain the safe full frame.
    return null;
  }
}
