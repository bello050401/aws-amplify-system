/**
 * BELLO画像自動加工システム(2026-08-30指示書)§18.1 自動テスト。
 * pipeline.ts(純粋ロジック)+ sharpProcessor.ts(実sharp呼び出し、
 * AWS/next不要)のstandalone verification。AWS認証情報が無いこの
 * サンドボックスでも実行できる範囲——ProcessingJob/ImageProcessingVersion
 * への実際のDynamoDB書き込みや、実BELLO家具写真でのPoCはここでは検証
 * しない(README/最終報告の「未実施」参照)。
 *
 * Run with: npm run verify:image-processing
 */
import sharp from "sharp";
import {
  buildIdempotencyKey,
  computeOriginalHash,
  decideAspectRatio,
  decideResultStatus,
  isValidStatusTransition,
  shouldApplyStrongComposition,
  DEFAULT_CONFIDENCE_THRESHOLD,
} from "@/lib/imageProcessing/pipeline";
import { SharpImageProcessingProvider, ENGINE_VERSION } from "@/lib/imageProcessing/sharpProcessor";

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

function assertTrue(cond: boolean, label: string) {
  assertEqual(cond, true, label);
}

function testAspectRatioDecision() {
  assertEqual(decideAspectRatio(null), "LANDSCAPE_3_2", "decideAspectRatio: 実測が無い(segmentation未実装)場合は安全側のLANDSCAPE_3_2");
  assertEqual(decideAspectRatio({ occupancySquareWouldBe: 0.7, nearEdge: false }), "SQUARE_1_1", "decideAspectRatio: 占有率がレンジ内かつ非edge-nearならSQUARE_1_1");
  assertEqual(decideAspectRatio({ occupancySquareWouldBe: 0.9, nearEdge: false }), "LANDSCAPE_3_2", "decideAspectRatio: 占有率がレンジ外ならLANDSCAPE_3_2");
  assertEqual(decideAspectRatio({ occupancySquareWouldBe: 0.7, nearEdge: true }), "LANDSCAPE_3_2", "decideAspectRatio: nearEdge=trueなら占有率に関わらずLANDSCAPE_3_2(切断回避優先、§6.1)");
}

function testCompositionStrength() {
  assertTrue(shouldApplyStrongComposition("TOP"), "shouldApplyStrongComposition: TOPは強い構図補正");
  assertTrue(shouldApplyStrongComposition("FULL"), "shouldApplyStrongComposition: FULLは強い構図補正");
  assertTrue(!shouldApplyStrongComposition("DETAIL"), "shouldApplyStrongComposition: DETAILは元構図優先(弱補正)");
  assertTrue(!shouldApplyStrongComposition("DAMAGE"), "shouldApplyStrongComposition: DAMAGEは元構図優先(商品状態を絶対に改変しない)");
  assertTrue(!shouldApplyStrongComposition("LABEL"), "shouldApplyStrongComposition: LABELは元構図優先");
}

function testIdempotencyKey() {
  const base = { storageKey: "inventory/a.jpg", originalHash: "hash1", engineVersion: 1, photoProfileVersion: 1, triggerType: "CATEGORY_TRANSITION" };
  const k1 = buildIdempotencyKey(base);
  const k2 = buildIdempotencyKey({ ...base });
  assertEqual(k1, k2, "buildIdempotencyKey: 同一入力は同一キー(決定論的)");
  assertTrue(k1 !== buildIdempotencyKey({ ...base, originalHash: "hash2" }), "buildIdempotencyKey: originalHashが違えば別キー(画像差し替えを別ジョブ扱い)");
  assertTrue(k1 !== buildIdempotencyKey({ ...base, engineVersion: 2 }), "buildIdempotencyKey: engineVersionが違えば別キー(アルゴリズム更新時の再加工を許可)");
  assertTrue(
    k1 !== buildIdempotencyKey({ ...base, triggerType: "MANUAL_REPROCESS", requestedAdjustments: { brightness: 1.2 } }),
    "buildIdempotencyKey: requestedAdjustmentsが違えば別キー(同じ画像への異なる手動再加工依頼は別ジョブ)",
  );

  const h1 = computeOriginalHash(Buffer.from("abc"));
  const h2 = computeOriginalHash(Buffer.from("abc"));
  const h3 = computeOriginalHash(Buffer.from("abd"));
  assertEqual(h1, h2, "computeOriginalHash: 同一バイト列は同一ハッシュ");
  assertTrue(h1 !== h3, "computeOriginalHash: 異なるバイト列は異なるハッシュ");
}

function testStatusTransitions() {
  assertTrue(isValidStatusTransition("UNPROCESSED", "QUEUED"), "状態遷移: UNPROCESSED→QUEUEDは有効");
  assertTrue(isValidStatusTransition("PROCESSING", "READY"), "状態遷移: PROCESSING→READYは有効");
  assertTrue(isValidStatusTransition("PROCESSING", "NEEDS_REVIEW"), "状態遷移: PROCESSING→NEEDS_REVIEWは有効");
  assertTrue(isValidStatusTransition("READY", "REPROCESSING"), "状態遷移: READY→REPROCESSING(§12の再加工)は有効");
  assertTrue(isValidStatusTransition("NEEDS_REVIEW", "READY"), "状態遷移: NEEDS_REVIEW→READY(ADMINによる手動承認)は有効");
  assertTrue(!isValidStatusTransition("UNPROCESSED", "READY"), "状態遷移: UNPROCESSED→READYへの直接遷移は無効(QUEUED/PROCESSINGを飛ばせない)");
  assertTrue(!isValidStatusTransition("SUPERSEDED", "READY"), "状態遷移: SUPERSEDEDからの遷移は無い(rollbackは新しいACTIVE切替であり、この行自体は変化しない)");
}

function testQualityGateDecision() {
  assertEqual(decideResultStatus({ readBackVerified: false, compositionConfidence: 0.9, confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD }), "FAILED", "decideResultStatus: 読み戻し検証失敗は常にFAILED(§17「生成後のJPEG/WebP等を読み戻せる」)");
  assertEqual(decideResultStatus({ readBackVerified: true, compositionConfidence: null, confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD }), "NEEDS_REVIEW", "decideResultStatus: confidence未計測(segmentation未実装)は常にNEEDS_REVIEW(§17「低confidenceを無理にREADYへしない」を安全側で徹底)");
  assertEqual(decideResultStatus({ readBackVerified: true, compositionConfidence: 0.9, confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD }), "READY", "decideResultStatus: 読み戻しOK・confidence十分ならREADY");
}

/** §18.1「実画像を使わずとも」sharpProcessor.tsが実際に動作することを検証する——sharp自身で生成した合成画像(単色矩形)を入力に使う。実BELLO家具写真によるPoC(§5)はこのラウンドでは未実施(理由: 最終報告参照)。 */
async function testSharpProcessorRoundTrip() {
  const synthetic = await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 200, g: 190, b: 170 } } }).jpeg().toBuffer();

  const provider = new SharpImageProcessingProvider();
  const result = await provider.process({ sourceBuffer: synthetic, classification: "TOP", aspectRatio: "SQUARE_1_1" });

  assertTrue(result.readBackVerified, "SharpImageProcessingProvider: TOP画像の出力3種(master/web/thumbnail)が全て読み戻し可能");
  assertEqual(result.floorCleanupApplied, false, "SharpImageProcessingProvider: floorCleanupApplied は常にfalse(§9未実装、fake successにしない)");
  assertTrue(result.width > 0 && result.height > 0, "SharpImageProcessingProvider: 出力サイズが正の値");

  const masterMeta = await sharp(result.masterJpeg).metadata();
  assertEqual(masterMeta.format, "jpeg", "SharpImageProcessingProvider: masterJpegは実際にJPEG形式");
  // §6.1「切断回避を数値目標より優先」——containを使うため、正方形指定でも
  // 元画像(1200x800)の中身が切り取られず全体が収まる(縦横比が
  // 1200x800の"contain"結果は幅=高さの正方形キャンバス内に収まる)。
  assertEqual(masterMeta.width, masterMeta.height, "SharpImageProcessingProvider: SQUARE_1_1指定時、TOP画像の出力は正方形(containで余白を足す、cropで切断しない)");

  const webMeta = await sharp(result.webWebp).metadata();
  assertEqual(webMeta.format, "webp", "SharpImageProcessingProvider: webWebpは実際にWebP形式");

  const thumbMeta = await sharp(result.thumbnailJpeg).metadata();
  assertTrue((thumbMeta.width ?? 0) <= 320 && (thumbMeta.height ?? 0) <= 320, "SharpImageProcessingProvider: thumbnailJpegは既存thumbnail.tsと同じ320px上限");

  // DETAIL画像はBELLO標準構図を強制しない——"contain"ではなく"inside"
  // (元のアスペクト比を維持)なので、正方形入力でなければ出力も正方形
  // にならない。
  const wideSynthetic = await sharp({ create: { width: 2000, height: 500, channels: 3, background: { r: 100, g: 100, b: 100 } } }).jpeg().toBuffer();
  const detailResult = await provider.process({ sourceBuffer: wideSynthetic, classification: "DETAIL", aspectRatio: "SQUARE_1_1" });
  const detailMeta = await sharp(detailResult.masterJpeg).metadata();
  assertTrue((detailMeta.width ?? 0) !== (detailMeta.height ?? 0), "SharpImageProcessingProvider: DETAIL画像は元のアスペクト比を維持(強制的な全体写真ルールから除外、§7)");

  // トーン補正が実際に画素値へ反映されることを確認(恒等変換でないことの確認)。
  const brightened = await provider.process({ sourceBuffer: synthetic, classification: "TOP", aspectRatio: "SQUARE_1_1", adjustments: { brightness: 1.5 } });
  const originalStats = await sharp(result.masterJpeg).stats();
  const brightenedStats = await sharp(brightened.masterJpeg).stats();
  assertTrue(brightenedStats.channels[0].mean > originalStats.channels[0].mean, "SharpImageProcessingProvider: brightness調整が実際に平均輝度を上げる(恒等変換で終わっていない)");

  // 破損データはFAILED相当(readBackVerified=false)になることを確認——
  // ただし入力が完全に不正な場合、sharpは.process()自体をthrowする
  // (これはdecideResultStatusより手前の話——呼び出し元(handler.ts)の
  // try/catchがFAILED/DEAD_LETTERへ倒す。ここではprocess自体が例外を
  // 投げることを確認するに留める)。
  try {
    await provider.process({ sourceBuffer: Buffer.from("not an image"), classification: "TOP", aspectRatio: "SQUARE_1_1" });
    failures++;
    console.error("✗ FAIL SharpImageProcessingProvider: 不正な入力データはthrowする(fake successにしない)");
  } catch {
    passes++;
    console.log("✓ SharpImageProcessingProvider: 不正な入力データはthrowする(fake successにしない)");
  }

  assertTrue(ENGINE_VERSION >= 1, "ENGINE_VERSION: 1以上の正の整数");
}

async function main() {
  testAspectRatioDecision();
  testCompositionStrength();
  testIdempotencyKey();
  testStatusTransitions();
  testQualityGateDecision();
  await testSharpProcessorRoundTrip();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
