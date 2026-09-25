import assert from "node:assert/strict";
import sharp from "sharp";
import { hasClearLogoCorner } from "../lib/brands/logoPlacement";
import { renderBrandedImage } from "../lib/brands/renderBrandedImage";

async function allowed(background: string): Promise<boolean> {
  const stats = await sharp({ create: { width: 160, height: 80, channels: 3, background } }).stats();
  return hasClearLogoCorner(stats);
}

async function main(): Promise<void> {
  assert.equal(await allowed("#ffffff"), true, "white empty background may receive a badge");
  assert.equal(await allowed("#222222"), false, "uniform dark product cannot be mistaken for empty space");
  assert.equal(await allowed("#f0c0c0"), false, "uniform colored product cannot be mistaken for empty space");

  const busyBytes = await sharp({ create: { width: 160, height: 80, channels: 3, background: "#ffffff" } })
    .composite([{ input: await sharp({ create: { width: 80, height: 80, channels: 3, background: "#555555" } }).png().toBuffer(), left: 80, top: 0 }])
    .png().toBuffer();
  const busy = await sharp(busyBytes).stats();
  assert.equal(hasClearLogoCorner(busy), false, "product entering the badge region must block placement");
  const source = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#ffffff" } }).png().toBuffer();
  const logo = await sharp({ create: { width: 300, height: 100, channels: 3, background: "#3355aa" } }).png().toBuffer();
  const rendered = await renderBrandedImage(source, logo);
  assert.equal((await sharp(rendered).metadata()).format, "jpeg", "generated listing image must be JPEG");
  assert.notDeepEqual(rendered, source, "original photo bytes remain unchanged");
  const center = await sharp(rendered).extract({ left: 1092, top: 734, width: 1, height: 1 }).raw().toBuffer();
  assert.ok(center[2] > center[0] + 40, "logo color appears in the bottom-right badge");
  await assert.rejects(async () => renderBrandedImage(await awaitableDark(), logo), /ロゴを重ねずに停止/);
  process.stdout.write("Brand logo checks passed (8/8).\n");
}

async function awaitableDark(): Promise<Buffer> {
  return sharp({ create: { width: 1200, height: 800, channels: 3, background: "#222222" } }).png().toBuffer();
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
