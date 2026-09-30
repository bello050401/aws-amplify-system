import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { hasClearLogoCorner } from "../lib/brands/logoPlacement";
import { renderBrandedImage } from "../lib/brands/renderBrandedImage";
import { readLimitedImage } from "../lib/brands/readLimitedImage";

async function allowed(background: string): Promise<boolean> {
  const stats = await sharp({ create: { width: 160, height: 80, channels: 3, background } }).stats();
  return hasClearLogoCorner(stats);
}

async function main(): Promise<void> {
  assert.equal((await readLimitedImage(new Response(new Uint8Array([1, 2, 3])), 3)).length, 3);
  await assert.rejects(() => readLimitedImage(new Response(new Uint8Array([1, 2, 3])), 2), /大きすぎ/);
  await assert.rejects(() => readLimitedImage(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "999" } }), 2), /大きすぎ/);
  assert.equal(await allowed("#ffffff"), true, "white empty background may receive a badge");
  assert.equal(await allowed("#222222"), false, "uniform dark product cannot be mistaken for empty space");
  assert.equal(await allowed("#f0c0c0"), false, "uniform colored product cannot be mistaken for empty space");

  const busyBytes = await sharp({ create: { width: 160, height: 80, channels: 3, background: "#ffffff" } })
    .composite([{ input: await sharp({ create: { width: 80, height: 80, channels: 3, background: "#555555" } }).png().toBuffer(), left: 80, top: 0 }])
    .png().toBuffer();
  const busy = await sharp(busyBytes).stats();
  assert.equal(hasClearLogoCorner(busy), false, "product entering the badge region must block placement");
  const source = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#ffffff" } }).png().toBuffer();
  const bello = await sharp({ create: { width: 200, height: 200, channels: 3, background: "#cc3322" } }).png().toBuffer();
  const logo = await sharp({ create: { width: 300, height: 100, channels: 3, background: "#3355aa" } }).png().toBuffer();
  const rendered = await renderBrandedImage(source, { bello, productBrand: logo });
  assert.equal((await sharp(rendered).metadata()).format, "jpeg", "generated listing image must be JPEG");
  assert.notDeepEqual(rendered, source, "original photo bytes remain unchanged");
  const belloPixel = await sharp(rendered).extract({ left: 100, top: 100, width: 1, height: 1 }).raw().toBuffer();
  assert.ok(belloPixel[0] > belloPixel[2] + 80, "BELLO mark appears at the top-left");
  const center = await sharp(rendered).extract({ left: 1092, top: 734, width: 1, height: 1 }).raw().toBuffer();
  assert.ok(center[2] > center[0] + 40, "product brand appears at the bottom-right");
  const belloOnly = await renderBrandedImage(source, { bello });
  const belloOnlyTop = await sharp(belloOnly).extract({ left: 100, top: 100, width: 1, height: 1 }).raw().toBuffer();
  const belloOnlyBottom = await sharp(belloOnly).extract({ left: 1092, top: 734, width: 1, height: 1 }).raw().toBuffer();
  assert.ok(belloOnlyTop[0] > belloOnlyTop[2] + 80, "BELLO remains when no product brand exists");
  assert.ok(belloOnlyBottom.every(value => value > 245), "no product brand leaves the bottom-right photo untouched");
  const largeSource = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#ffffff" } }).jpeg().toBuffer();
  const largeHash = createHash("sha256").update(largeSource).digest("hex");
  const largeResult = await renderBrandedImage(largeSource, { bello, productBrand: logo });
  const largeSize = await sharp(largeResult).metadata();
  assert.deepEqual([largeSize.width, largeSize.height], [3000, 2000], "photos over 2400px keep their dimensions");
  assert.equal(createHash("sha256").update(largeSource).digest("hex"), largeHash, "original large photo stays unchanged");
  const rotatedSource = await sharp({ create: { width: 120, height: 80, channels: 3, background: "#ffffff" } })
    .jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const rotatedHash = createHash("sha256").update(rotatedSource).digest("hex");
  const rotatedResult = await renderBrandedImage(rotatedSource, { bello });
  const rotatedSize = await sharp(rotatedResult).metadata();
  assert.deepEqual([rotatedSize.width, rotatedSize.height], [80, 120], "EXIF orientation is normalized without resizing");
  assert.equal(createHash("sha256").update(rotatedSource).digest("hex"), rotatedHash, "rotated original stays unchanged");
  const chair = await sharp({ create: { width: 500, height: 600, channels: 3, background: "#775533" } }).png().toBuffer();
  const photoWithClearCorner = await sharp(source).composite([{ input: chair, left: 100, top: 100 }]).png().toBuffer();
  await renderBrandedImage(photoWithClearCorner, { bello, productBrand: logo });
  const photoWithBlockedCorner = await sharp(source).composite([{ input: chair, left: 700, top: 200 }]).png().toBuffer();
  for (const photo of [photoWithBlockedCorner, await awaitableDark()]) {
    const footerImage = await renderBrandedImage(photo, { bello, productBrand: logo });
    const meta = await sharp(footerImage).metadata();
    assert.equal(meta.width, 1200);
    assert.equal(meta.height, 800, "direct overlay preserves photo dimensions without extra space");
    const pixel = await sharp(footerImage).extract({ left: 1092, top: 750, width: 1, height: 1 }).raw().toBuffer();
    assert.ok(pixel[2] > pixel[0] + 40, "logo appears directly on the bottom-right photo area");
  }
  const transparentLogo = await sharp({ create: { width: 300, height: 100, channels: 4, background: "#00000000" } })
    .composite([{ input: await sharp({ create: { width: 100, height: 100, channels: 4, background: "#3355aaff" } }).png().toBuffer(), left: 100, top: 0 }])
    .png().toBuffer();
  const transparentOverlay = await renderBrandedImage(await awaitableDark(), { bello, productBrand: transparentLogo });
  const untouched = await sharp(transparentOverlay).extract({ left: 1010, top: 750, width: 1, height: 1 }).raw().toBuffer();
  assert.ok(untouched.every(value => Math.abs(value - 34) < 8), "transparent logo area retains the photo, without a generated white badge");
  const suppliedBello = await readFile(join(process.cwd(), "public", "bello-interior-listing-logo.png"));
  assert.equal(createHash("sha256").update(suppliedBello).digest("hex"),
    "caf081a0f66d961566e8e37123debc8b3f7161a5ca3ff133c0bf70e04ce3d044", "supplied logo bytes are unchanged");
  const suppliedMetadata = await sharp(suppliedBello).metadata();
  assert.deepEqual([suppliedMetadata.width, suppliedMetadata.height], [1181, 591], "wide BELLO INTERIOR logo keeps its source proportions");
  const suppliedOverlay = await renderBrandedImage(source, { bello: suppliedBello, productBrand: logo });
  assert.deepEqual([ (await sharp(suppliedOverlay).metadata()).width, (await sharp(suppliedOverlay).metadata()).height ], [1200, 800],
    "supplied logo adds no canvas around the photo");
  if (process.env.BELLO_LOGO_PREVIEW_DIR) {
    const furniture = await sharp({ create: { width: 760, height: 500, channels: 3, background: "#796c5f" } }).png().toBuffer();
    const photo = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#dedbd5" } })
      .composite([{ input: furniture, left: 220, top: 170 }]).png().toBuffer();
    await writeFile(join(process.env.BELLO_LOGO_PREVIEW_DIR, "bello-only.jpg"), await renderBrandedImage(photo, { bello: suppliedBello }));
    await writeFile(join(process.env.BELLO_LOGO_PREVIEW_DIR, "bello-and-product-brand.jpg"), await renderBrandedImage(photo, { bello: suppliedBello, productBrand: logo }));
  }
  process.stdout.write("Brand logo checks passed including direct overlay without added space.\n");
}

async function awaitableDark(): Promise<Buffer> {
  return sharp({ create: { width: 1200, height: 800, channels: 3, background: "#222222" } }).png().toBuffer();
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
