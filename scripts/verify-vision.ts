/**
 * AI Vision層の検証（2026-08-31 AI Vision統合仕様書 §21 / §45 / §46）。
 *
 * 実モデルへは接続しない。CIで毎回課金しないため、モック解析器を通して
 * 検証層とルーティングのふるまいを確認する（§46）。
 *
 * **ここが通ることは実機検証ではない。** 報告では MOCK VERIFIED と
 * REAL MODEL VERIFIED を区別すること。
 *
 * Run with: npm run verify:vision
 */
import { extractJson, iou, overlapRatio, unionRect, validateVisionResponse } from "@/lib/imageProcessing/vision/validate";
import { MockVisionAnalyzer, NullVisionAnalyzer, ROUND_TABLE_FIXTURE } from "@/lib/imageProcessing/vision/mockVisionAnalyzer";
import {
  cropIncludesAvoidRegion,
  decideVisionRouting,
  mergeVisionWithLocal,
  IMPLAUSIBLE_BBOX_AREA,
  LOCAL_CONFIDENCE_SUFFICIENT,
} from "@/lib/imageProcessing/vision/router";
import { MIN_CROP_CONFIDENCE } from "@/lib/imageProcessing/cropPlanner";
import type { VisionAnalysisInput } from "@/lib/imageProcessing/vision/types";

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

const input: VisionAnalysisInput = {
  imageJpeg: Buffer.from([0xff, 0xd8, 0xff]),
  imageWidth: 1024,
  imageHeight: 576,
  localBbox: { x: 0.4, y: 0.32, width: 0.26, height: 0.44 },
  localConfidence: 0.3,
  sourceHash: "hash-round-table",
  trigger: "DARK_SCENE",
};

function testJsonExtraction() {
  assertTrue(extractJson('{"a":1}') !== null, "extractJson: 素のJSONを読める");
  assertTrue(extractJson('```json\n{"a":1}\n```') !== null, "extractJson: コードフェンス付きでも読める");
  assertTrue(extractJson('前置きです {"a":1} 後書きです') !== null, "extractJson: 前後に文章があっても読める");
  assertEqual(extractJson("これはJSONではありません"), null, "extractJson: JSONが無ければnull");
  assertEqual(extractJson('{"a":'), null, "extractJson: 壊れたJSONはnull（無理に修復しない）");
  assertEqual(extractJson(""), null, "extractJson: 空文字はnull");
}

function testValidation() {
  const opts = { modelId: "m", latencyMs: 1 };

  const ok = validateVisionResponse(JSON.parse(ROUND_TABLE_FIXTURE), opts);
  assertTrue(ok !== null, "検証: 実機で観測した応答を受け入れる");
  assertEqual(ok?.irrelevantObjects.length, 1, "検証: 撮影機材を1件として取り込む");
  assertEqual(ok?.irrelevantObjects[0].label, "撮影機材", "検証: ラベルを保持する");
  assertEqual(ok?.recommendedAspect, "SQUARE_1_1", "検証: 想定内のアスペクト値だけ受け入れる");

  // 壊れた応答は「捨てる」。推測で埋めない。
  assertEqual(validateVisionResponse(null, opts), null, "検証: nullは拒否");
  assertEqual(validateVisionResponse({ product_detected: "yes" }, opts), null, "検証: 型が違うproduct_detectedは拒否");
  assertEqual(
    validateVisionResponse({ product_detected: true, confidence: 0.9 }, opts),
    null,
    "検証: 商品ありと言いながらbboxが無い応答は拒否",
  );
  assertEqual(
    validateVisionResponse({ product_detected: true, confidence: NaN, product_bbox: { x: 0, y: 0, width: 1, height: 1 } }, opts),
    null,
    "検証: NaNのconfidenceは拒否",
  );
  assertEqual(
    validateVisionResponse(
      { product_detected: true, confidence: 0.9, product_bbox: { x: 0, y: 0, width: Infinity, height: 1 } },
      opts,
    ),
    null,
    "検証: Infinityを含む座標は拒否",
  );
  assertEqual(
    validateVisionResponse({ product_detected: true, confidence: 0.9, product_bbox: { x: 0.5, y: 0.5, width: 2, height: 2 } }, opts),
    null,
    "検証: 画面を大きくはみ出す矩形は拒否",
  );
  assertEqual(
    validateVisionResponse({ product_detected: true, confidence: 0.9, product_bbox: { x: 0.1, y: 0.1, width: -0.2, height: 0.3 } }, opts),
    null,
    "検証: 負の幅は拒否",
  );

  // 「商品が見つからなかった」は正常な応答
  const notFound = validateVisionResponse({ product_detected: false, confidence: 0.2 }, opts);
  assertTrue(notFound !== null, "検証: 商品なしの応答は正常として受け入れる");
  assertEqual(notFound?.productBbox, null, "検証: 商品なしならbboxはnull");

  // 想定外のアスペクト値は捨てて null にする（勝手に既定値へ寄せない）
  const weird = validateVisionResponse(
    { product_detected: true, confidence: 0.8, product_bbox: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }, recommended_aspect: "PORTRAIT_9_16" },
    opts,
  );
  assertEqual(weird?.recommendedAspect, null, "検証: 未知のアスペクト値は採用しない");
}

function testOverlapMetrics() {
  const small = { x: 0.4, y: 0.32, width: 0.26, height: 0.44 };
  const full = { x: 0, y: 0, width: 1, height: 1 };

  // 包含率とIoUは別物。ここを取り違えると「画面全体が商品」という
  // 最も危険な応答を「完全に一致」と判定してしまう（実際にテストで出た）。
  assertEqual(Math.round(overlapRatio(small, full) * 100), 100, "指標: 包含率は全画面bboxに対して1.0になる");
  assertTrue(iou(small, full) < 0.2, "指標: IoUは全画面bboxを一致とみなさない");

  const near = { x: 0.4, y: 0.31, width: 0.28, height: 0.46 };
  assertTrue(iou(small, near) >= 0.6, "指標: 実際に近い2つの見立てはIoUでも一致とみなす");

  const disjoint = { x: 0.0, y: 0.0, width: 0.2, height: 0.2 };
  assertEqual(iou(small, disjoint), 0, "指標: 重ならない矩形のIoUは0");
  assertEqual(overlapRatio(small, disjoint), 0, "指標: 重ならない矩形の包含率は0");
}

function testRouting() {
  const base = { localConfidence: 0.9, hasLocalSubject: true, backgroundLuminance: 180, subjectTouchesFrameEdge: false };

  assertEqual(decideVisionRouting(base).useVision, false, "ルーティング: ローカルが十分なら呼ばない（既定は呼ばない）");
  assertEqual(
    decideVisionRouting({ ...base, hasLocalSubject: false }).reason,
    "NO_LOCAL_SUBJECT",
    "ルーティング: 商品を見つけられなければ呼ぶ",
  );
  assertEqual(
    decideVisionRouting({ ...base, localConfidence: 0.2 }).reason,
    "LOW_LOCAL_CONFIDENCE",
    "ルーティング: 確信度が低ければ呼ぶ",
  );
  assertEqual(
    decideVisionRouting({ ...base, backgroundLuminance: 51, localConfidence: 0.45 }).reason,
    "DARK_SCENE",
    "ルーティング: 暗所で確信度が中程度なら呼ぶ",
  );
  assertEqual(
    decideVisionRouting({ ...base, backgroundLuminance: 51, localConfidence: 0.9 }).useVision,
    false,
    "ルーティング: 暗所でもローカルが十分なら呼ばない（丸テーブルは露出補正で自力解決した）",
  );
  assertEqual(
    decideVisionRouting({ ...base, subjectTouchesFrameEdge: true, localConfidence: 0.5 }).reason,
    "SUSPECTED_IRRELEVANT_OBJECT",
    "ルーティング: 端に接していて確信度が足りなければ不要物を疑う",
  );
  assertTrue(LOCAL_CONFIDENCE_SUFFICIENT > 0 && LOCAL_CONFIDENCE_SUFFICIENT < 1, "ルーティング: 閾値が0..1に収まっている");
}

async function testMergeAndSafety() {
  const analyzer = new MockVisionAnalyzer(() => ROUND_TABLE_FIXTURE);
  const vision = await analyzer.analyze(input);
  assertTrue(vision !== null, "モック: 実機で観測した応答を返せる");

  // 見立てが一致するケース
  const agree = mergeVisionWithLocal(input.localBbox, 0.3, vision);
  assertTrue(agree.bbox !== null, "統合: bboxが得られる");
  assertTrue(agree.confidence > 0.3, "統合: AIと一致すれば確信度が上がる");
  assertEqual(agree.avoidRegions.length, 1, "統合: 撮影機材が回避領域として渡る");
  assertTrue(agree.reasonCodes.includes("AI_ASSISTED_CROP"), "統合: AIを使ったことが理由コードに残る");

  // 大きく食い違うケース → 保守側へ倒す
  const disagree = mergeVisionWithLocal({ x: 0.02, y: 0.02, width: 0.15, height: 0.15 }, 0.8, vision);
  assertTrue(disagree.confidence <= 0.45, "統合: 大きく食い違えば確信度を下げる");
  assertTrue(disagree.reasonCodes.includes("AI_LOCAL_DISAGREEMENT"), "統合: 食い違いを理由コードへ残す");
  const union = unionRect({ x: 0.02, y: 0.02, width: 0.15, height: 0.15 }, vision!.productBbox);
  assertEqual(disagree.bbox, union, "統合: 食い違い時は和集合（切るより緩める）");

  // AIが使えないケース
  const none = mergeVisionWithLocal(input.localBbox, 0.3, null);
  assertEqual(none.bbox, input.localBbox, "統合: AIが無ければローカルの見立てをそのまま使う");
  assertEqual(none.confidence, 0.3, "統合: AIが無くても確信度は変えない");
  assertTrue(none.reasonCodes.includes("VISION_UNAVAILABLE"), "統合: AI不在を理由コードへ残す");

  // 不要物がcrop内に残っているかの判定
  const avoid = [{ x: 0.84, y: 0.19, width: 0.16, height: 0.37 }];
  assertTrue(cropIncludesAvoidRegion({ x: 0.7, y: 0.1, width: 0.3, height: 0.6 }, avoid), "安全: 機材を含むcropを検知する");
  assertTrue(!cropIncludesAvoidRegion({ x: 0.1, y: 0.2, width: 0.5, height: 0.6 }, avoid), "安全: 機材を外したcropは通す");
}

/**
 * ローカルが商品を見つけられなかったとき（NO_LOCAL_SUBJECT）の扱い。
 *
 * 比較相手が無いので一致度で守れない。ここでAIの答えをそのまま通すと、
 * 「画面全体が商品」という答えが確信度0.6で採用され、MIN_CROP_CONFIDENCE
 * (0.45)を超えてcropまで進んでしまう。実際にE2Eで確信度0.60が出た。
 */
async function testNoLocalSubject() {
  const good = await new MockVisionAnalyzer(() => ROUND_TABLE_FIXTURE).analyze(input);
  const greedy = await new MockVisionAnalyzer(() =>
    JSON.stringify({ product_detected: true, confidence: 0.99, product_bbox: { x: 0, y: 0, width: 1, height: 1 } }),
  ).analyze(input);

  // ローカルが見つけられず、AIがまともに答えた場合は採用してよい。
  const rescued = mergeVisionWithLocal(null, 0, good);
  assertEqual(rescued.bbox, good!.productBbox, "商品未検出: AIの座標で救済する");
  assertTrue(rescued.confidence > 0 && rescued.confidence <= 0.6, "商品未検出: 救済時も確信度は上限つき");
  assertTrue(!rescued.reasonCodes.includes("AI_BBOX_IMPLAUSIBLE"), "商品未検出: まともな座標を却下しない");

  // ローカルが見つけられず、AIが画面全体を主張した場合は使えない。
  const bailed = mergeVisionWithLocal(null, 0, greedy);
  assertTrue(bailed.confidence <= 0.4, "商品未検出: 全画面bboxは比較相手が無くても採用しない");
  assertTrue(bailed.confidence < MIN_CROP_CONFIDENCE, "商品未検出: cropの下限を下回らせる（構図を触らせない）");
  assertTrue(bailed.reasonCodes.includes("AI_BBOX_IMPLAUSIBLE"), "商品未検出: 却下の理由を残す");
  assertEqual(bailed.bbox, null, "商品未検出: 使えない座標を被写体として持ち回らない");

  // ローカルの見立てがある場合も、大きすぎる主張はそこで弾く。
  const withLocal = mergeVisionWithLocal(input.localBbox, 0.5, greedy);
  assertEqual(withLocal.bbox, input.localBbox, "全画面bbox: ローカルの見立てを保つ");
  assertTrue(withLocal.reasonCodes.includes("AI_BBOX_IMPLAUSIBLE"), "全画面bbox: 一致判定より前に弾く");

  // 境界: 閾値のすぐ下は通す。
  const large = await new MockVisionAnalyzer(() =>
    JSON.stringify({ product_detected: true, confidence: 0.9, product_bbox: { x: 0.05, y: 0.05, width: 0.8, height: 0.8 } }),
  ).analyze(input);
  assertEqual(Math.round(0.8 * 0.8 * 100) / 100, 0.64, "境界: 0.8×0.8=0.64 は閾値0.7未満");
  const okLarge = mergeVisionWithLocal(null, 0, large);
  assertTrue(!okLarge.reasonCodes.includes("AI_BBOX_IMPLAUSIBLE"), "境界: 面積0.64の主張は却下しない");
  assertTrue(IMPLAUSIBLE_BBOX_AREA > 0.6 && IMPLAUSIBLE_BBOX_AREA <= 1, "境界: 閾値が妥当な範囲にある");
}

async function testFailureModes() {
  // 壊れたJSON
  const broken = new MockVisionAnalyzer(() => '{"product_detected": true, "confid');
  assertEqual(await broken.analyze(input), null, "障害: 壊れたJSONはnull（例外を投げない）");

  // 自然文だけ
  const prose = new MockVisionAnalyzer(() => "画像には木製のテーブルが写っています。");
  assertEqual(await prose.analyze(input), null, "障害: 自然文だけの応答は採用しない");

  // タイムアウト等の例外
  const throwing = new MockVisionAnalyzer(() => new Error("VISION_TIMEOUT"));
  assertEqual(await throwing.analyze(input), null, "障害: タイムアウトはnullとして扱う");

  // 危険な座標（画面全体を商品と主張）— 検証は通るが、統合側で確信度が下がる
  const greedy = new MockVisionAnalyzer(() =>
    JSON.stringify({ product_detected: true, confidence: 0.99, product_bbox: { x: 0, y: 0, width: 1, height: 1 } }),
  );
  const greedyResult = await greedy.analyze(input);
  assertTrue(greedyResult !== null, "障害: 全画面bboxは形式としては受け入れる");
  const merged = mergeVisionWithLocal(input.localBbox, 0.8, greedyResult);
  assertTrue(merged.confidence <= 0.45, "障害: 全画面bboxはローカルと食い違うため確信度を下げる（盲信しない）");

  // 無効化された解析器
  const off = new NullVisionAnalyzer();
  assertEqual(await off.analyze(), null, "障害: 無効化時は常にnull");
}

async function testCostControl() {
  let calls = 0;
  const analyzer = new MockVisionAnalyzer(() => { calls++; return ROUND_TABLE_FIXTURE; });

  // ルーティングが呼ばないと判断したら、解析器に触れない
  const decision = decideVisionRouting({ localConfidence: 0.9, hasLocalSubject: true, backgroundLuminance: 180, subjectTouchesFrameEdge: false });
  if (decision.useVision) await analyzer.analyze(input);
  assertEqual(calls, 0, "コスト: ローカルが十分な画像ではAIを1回も呼ばない");

  const hard = decideVisionRouting({ localConfidence: 0.2, hasLocalSubject: true, backgroundLuminance: 51, subjectTouchesFrameEdge: true });
  if (hard.useVision) await analyzer.analyze(input);
  assertEqual(calls, 1, "コスト: 難例のときだけ呼ぶ");
  assertEqual(analyzer.calls, 1, "コスト: 呼び出し回数を観測できる");
}

async function main(): Promise<void> {
  testJsonExtraction();
  testValidation();
  testOverlapMetrics();
  testRouting();
  await testMergeAndSafety();
  await testNoLocalSubject();
  await testFailureModes();
  await testCostControl();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exitCode = 1;
}

void main();
