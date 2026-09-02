/**
 * 画像加工の入力のふちを、**その場で作った画像**で検証する。
 *
 * ── 本番の画像には一切触らない ──────────────────────────────────
 *
 * fixtureはすべて sharp でメモリ上に生成する。S3も読まないし、既存の
 * 加工結果も上書きしない。ネットワークもAWS認証情報も要らない。
 *
 * ── 何を見ているか ──────────────────────────────────────────────
 *
 * 加工の「良し悪し」ではなく、**壊れた入力で壊れないこと**と
 * **出してはいけないものを出さないこと**。指示書が名指ししていた
 * EXIF・形式・巨大・透過・色空間・破損・0バイト・S3キー衝突を順に見る。
 *
 * Run with: npm run verify:image-fixtures
 */
import sharp from "sharp";
import { SharpImageProcessingProvider } from "@/lib/imageProcessing/sharpProcessor";
import { computeOriginalHash } from "@/lib/imageProcessing/pipeline";

let failures = 0;
let passes = 0;
function assertEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ FAIL ${label}\n    expected: ${e}\n    actual:   ${a}`);
  } else {
    passes++;
    console.log(`✓ ${label}`);
  }
}
const assertTrue = (c: boolean, label: string) => assertEqual(c, true, label);

async function assertRejects(fn: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await fn();
  } catch {
    passes++;
    console.log(`✓ ${label}`);
    return;
  }
  failures++;
  console.error(`✗ FAIL ${label}\n    expected: 例外, actual: 正常終了`);
}

const provider = new SharpImageProcessingProvider();
const run = (sourceBuffer: Buffer) =>
  provider.process({ sourceBuffer, classification: "FULL", aspectRatio: "SQUARE_1_1" });

/** 中央に被写体らしい矩形を置いた、素性の分かっている画像を作る。 */
async function makeFixture(opts: {
  width: number;
  height: number;
  format?: "jpeg" | "png" | "webp";
  alpha?: boolean;
  grayscale?: boolean;
}): Promise<Buffer> {
  const { width, height, format = "jpeg", alpha = false, grayscale = false } = opts;
  const channels: 3 | 4 = alpha ? 4 : 3;
  const bg = alpha ? { r: 240, g: 240, b: 240, alpha: 0 } : { r: 240, g: 240, b: 240 };
  let img = sharp({ create: { width, height, channels, background: bg } }).composite([
    {
      // 中央に濃い矩形 = 被写体。端に接しないよう内側へ置く。
      input: {
        create: {
          width: Math.max(1, Math.floor(width * 0.5)),
          height: Math.max(1, Math.floor(height * 0.5)),
          channels: 3,
          background: { r: 40, g: 60, b: 90 },
        },
      },
      gravity: "center",
    },
  ]);
  if (grayscale) img = img.grayscale();
  if (format === "png") return img.png().toBuffer();
  if (format === "webp") return img.webp().toBuffer();
  return img.jpeg().toBuffer();
}

/* ══════════════════════════════════════════════════════════════════
 * 1. 壊れた入力で「壊れる」のではなく「失敗する」
 * ══════════════════════════════════════════════════════════════════
 * ここで欲しいのは、握り潰して成功のふりをしないこと。加工に失敗した
 * 画像をREADYにすると、壊れた画像がECへ出る。
 */
async function testBrokenInput() {
  await assertRejects(() => run(Buffer.alloc(0)), "壊れた入力: 0バイトは例外になる(成功のふりをしない)");
  await assertRejects(
    () => run(Buffer.from("これは画像ではありません", "utf8")),
    "壊れた入力: ただのテキストは例外になる",
  );

  // JPEGのマジックナンバーだけ本物で、中身が無い。ヘッダだけを見て
  // 通してしまう実装だと、ここで初めて落ちる。
  const fakeJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
  await assertRejects(() => run(fakeJpeg), "壊れた入力: ヘッダだけJPEGで中身が無いものは例外になる");

  // 途中で切れたJPEG。転送中断・アップロード失敗で実際に起こる形。
  const whole = await makeFixture({ width: 200, height: 200 });
  const truncated = whole.subarray(0, Math.floor(whole.length / 3));
  await assertRejects(() => run(truncated), "壊れた入力: 途中で切れたJPEGは例外になる");
}

/* ══════════════════════════════════════════════════════════════════
 * 2. 形式・色空間・透過
 * ══════════════════════════════════════════════════════════════════ */
async function testFormats() {
  for (const format of ["jpeg", "png", "webp"] as const) {
    const src = await makeFixture({ width: 400, height: 300, format });
    const r = await run(src);
    assertTrue(r.masterJpeg.length > 0, `形式: ${format} を受け付けてマスターを作る`);
    assertEqual((await sharp(r.masterJpeg).metadata()).format, "jpeg", `形式: ${format} から作ったマスターはJPEG`);
    assertEqual((await sharp(r.webWebp).metadata()).format, "webp", `形式: ${format} から作った公開用はWebP`);
    assertTrue(r.readBackVerified, `形式: ${format} の生成物は読み戻し検証を通っている`);
  }

  // 透過PNG。removeAlpha() を通すので出力に透過は残らない。残ったまま
  // JPEGにすると透過部分が黒く潰れる。
  const transparent = await makeFixture({ width: 300, height: 300, format: "png", alpha: true });
  const tr = await run(transparent);
  assertEqual((await sharp(tr.masterJpeg).metadata()).hasAlpha, false, "透過: 出力のマスターにアルファは残らない");
  assertTrue(tr.readBackVerified, "透過: 透過PNGでも読み戻し検証を通る");

  // グレースケール。チャンネル数を3固定で書いていると落ちる。
  const gray = await makeFixture({ width: 320, height: 240, grayscale: true });
  const gr = await run(gray);
  assertTrue(gr.masterJpeg.length > 0, "色空間: グレースケールでも加工できる");
  assertTrue(gr.readBackVerified, "色空間: グレースケールの生成物も読み戻せる");
}

/* ══════════════════════════════════════════════════════════════════
 * 3. EXIF
 * ══════════════════════════════════════════════════════════════════
 * 入力のorientationは尊重し、出力には持ち出さない。位置情報を付けた
 * ままECへ出すと、撮影場所(=倉庫や自宅)が公開される。
 */
async function testExif() {
  // orientation=6 (右90度回転して表示すべき) を付けた画像。
  const tall = await sharp({
    create: { width: 200, height: 400, channels: 3, background: { r: 200, g: 200, b: 200 } },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();

  assertEqual((await sharp(tall).metadata()).orientation, 6, "EXIF: fixtureにorientationが付いている(前提の確認)");

  const r = await run(tall);
  const outOrientation = (await sharp(r.masterJpeg).metadata()).orientation;
  assertTrue(
    outOrientation === undefined || outOrientation === 1,
    "EXIF: 出力のorientationは正規化済み(見る側の実装差で回転しない)",
  );

  assertTrue(!(await sharp(r.webWebp).metadata()).exif, "EXIF: 公開用WebPにEXIFを含めない(GPS等を持ち出さない)");
  assertTrue(!(await sharp(r.thumbnailJpeg).metadata()).exif, "EXIF: サムネイルにもEXIFを含めない");
}

/* ══════════════════════════════════════════════════════════════════
 * 4. 大きさのふち
 * ══════════════════════════════════════════════════════════════════ */
async function testDimensions() {
  // 極端に細長い。crop計算で幅か高さが0になると sharp が落ちる。
  const wide = await makeFixture({ width: 2000, height: 100 });
  const w = await run(wide);
  assertTrue(w.width > 0 && w.height > 0, "大きさ: 極端に横長でも幅・高さが0にならない");
  assertTrue(w.readBackVerified, "大きさ: 極端に横長でも生成物を読み戻せる");

  const narrow = await makeFixture({ width: 100, height: 2000 });
  const n = await run(narrow);
  assertTrue(n.width > 0 && n.height > 0, "大きさ: 極端に縦長でも幅・高さが0にならない");

  // 非常に小さい。切り出しの結果が1px未満になりうる。
  const tiny = await makeFixture({ width: 16, height: 16 });
  const t = await run(tiny);
  assertTrue(t.width > 0 && t.height > 0, "大きさ: 16pxでも破綻しない");
  assertTrue(t.readBackVerified, "大きさ: 16pxの生成物も読み戻せる");

  // サムネイルは必ずマスターより小さい。逆なら一覧の転送量削減が効かない。
  const normal = await makeFixture({ width: 1600, height: 1200 });
  const r = await run(normal);
  assertTrue(
    r.thumbnailJpeg.length < r.masterJpeg.length,
    `圧縮: サムネイルはマスターより小さい(${r.thumbnailJpeg.length} < ${r.masterJpeg.length})`,
  );
  const masterWidth = (await sharp(r.masterJpeg).metadata()).width ?? 0;
  const thumbWidth = (await sharp(r.thumbnailJpeg).metadata()).width ?? 0;
  assertTrue(thumbWidth <= masterWidth, "圧縮: サムネイルの寸法はマスター以下");
}

/* ══════════════════════════════════════════════════════════════════
 * 5. S3キーの衝突
 * ══════════════════════════════════════════════════════════════════
 * 同じ内容の画像は同じハッシュ、違えば違うハッシュ。ここが崩れると
 * 別の商品の画像を「同じもの」とみなして取り違える。
 */
function testHashCollision(a: Buffer, b: Buffer, c: Buffer) {
  const ha = computeOriginalHash(a);
  const hb = computeOriginalHash(b);
  const hc = computeOriginalHash(c);

  assertEqual(ha, hb, "ハッシュ: 同じ内容なら同じ値(再加工で無駄に作り直さない)");
  assertTrue(ha !== hc, "ハッシュ: 1px違えば違う値(別画像を同一視しない)");
  assertEqual(ha.length, 64, "ハッシュ: SHA-256のhex 64桁");
  assertTrue(/^[0-9a-f]+$/.test(ha), "ハッシュ: 16進の小文字だけ(S3キーに使える文字)");
  assertEqual(computeOriginalHash(Buffer.alloc(0)).length, 64, "ハッシュ: 0バイトでも64桁を返す");
}

/* ══════════════════════════════════════════════════════════════════
 * 6. 同じ入力からは同じ結果(冪等)
 * ══════════════════════════════════════════════════════════════════
 * 再加工のたびに違う結果が出ると、差分が出続けて何が変わったのか
 * 分からなくなる。
 */
async function testDeterminism() {
  const src = await makeFixture({ width: 640, height: 480 });
  const first = await run(src);
  const second = await run(src);

  assertEqual(first.width, second.width, "冪等: 同じ入力なら幅が同じ");
  assertEqual(first.height, second.height, "冪等: 同じ入力なら高さが同じ");
  assertEqual(
    computeOriginalHash(first.masterJpeg),
    computeOriginalHash(second.masterJpeg),
    "冪等: 同じ入力なら生成されるマスターのバイト列も同じ",
  );
  assertEqual(first.floorCleanupApplied, false, "未実装: 床クリーニングは常にfalse(できたふりをしない)");
}

async function main() {
  await testBrokenInput();
  await testFormats();
  await testExif();
  await testDimensions();
  testHashCollision(
    await makeFixture({ width: 200, height: 200 }),
    await makeFixture({ width: 200, height: 200 }),
    await makeFixture({ width: 201, height: 200 }),
  );
  await testDeterminism();

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}

void main();
