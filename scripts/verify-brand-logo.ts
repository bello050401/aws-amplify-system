import assert from "node:assert/strict";
import sharp from "sharp";
import { hasClearLogoCorner } from "../lib/brands/logoPlacement";

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
  process.stdout.write("Brand logo corner checks passed (4/4).\n");
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
