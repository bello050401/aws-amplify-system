import { borderLikelihood, type ImageAnalysis, type NormalizedRect } from "./analysis";
import { cropIncludesAvoidRegion } from "./vision/router";

/**
 * BELLO画像自動加工 — 構図の再設計(2026-08-31 画像自動加工完全仕様書 §8 Stage 2 / §27)。
 *
 * ## これが品質改善の主要因
 *
 * 提示された4組のBefore/Afterで最も大きく変わっているのは構図である。
 * 実測した被写体の占有面積は、4組すべてでおよそ2倍になっていた
 * (椅子 3.1%→6.4% / ピンク 5.2%→12.6% / ソファ 4.3%→16.3% /
 *  丸テーブル 0.9%→7.9%)。
 *
 * 従来実装は`sharp.resize({fit:"contain"})`で目標比率へ合わせていたため、
 * 16:9の元画像を1:1や3:2へ入れると**白帯が足されて家具はさらに小さくなる**。
 * 求められているのと逆向きだった。ここでは白帯を一切足さず、cropだけで
 * 構図を作る(§8「originalにない背景を生成してcanvasを広げない」)。
 *
 * ## 安全側の原則
 *
 * - 家具を切らない。切るくらいなら拡大しない。
 * - 接地している床を残す(家具が宙に浮いて見えない)。
 * - 検出の確信度が低いときは元の構図を保つ(§27)。
 * - cropは必ず元画像の内側。canvasを広げない。
 */

export type OutputAspect = "SQUARE_1_1" | "LANDSCAPE_3_2" | "ORIGINAL";

/** 家具の大まかな形。余白の取り方を変えるために使う(§8「家具カテゴリ別」)。 */
export type SubjectShape = "TALL" | "WIDE" | "BALANCED";

export interface CropTargets {
  /**
   * 被写体の長い方の辺が、出力フレームのどれだけを占めるか(0..1)。
   *
   * 既定値0.68は、提示された理想写真(After)4枚から実測した被写体の
   * 最大相対寸法(0.54 / 0.46 / 0.77 / 0.55)の分布に収まる値として選んだ。
   * Photo Profileが理想写真から算出した値があれば、そちらで上書きされる
   * (§4「固定プリセットではなく、完成写真の到達状態をProfileが保持する」)。
   */
  maxSubjectExtent: number;
  /** 各辺に最低限残す余白(出力フレーム比)。家具がフレームぎりぎりになるのを防ぐ。 */
  minMarginRatio: number;
  /** 接地部の下に残す床の余白(出力フレーム比)。影と接地感を残すため上下非対称にする。 */
  floorMarginRatio: number;
}

export const DEFAULT_CROP_TARGETS: CropTargets = {
  maxSubjectExtent: 0.68,
  minMarginRatio: 0.06,
  floorMarginRatio: 0.09,
};

/** 確信度がこれ未満なら自動cropしない(§27「検出confidenceが低い場合は保守的cropにする」)。 */
export const MIN_CROP_CONFIDENCE = 0.45;

export interface CropPlan {
  /** 元画像に対する切り出し矩形(正規化座標)。cropしない場合は全面。 */
  rect: NormalizedRect;
  /** 実際にcropで構図を変えたか。falseなら元の構図のまま。 */
  applied: boolean;
  /** なぜその判断になったか。UIとログで「なぜこう加工されたのか」を説明するために持つ。 */
  reason:
    | "APPLIED"
    | "LOW_CONFIDENCE"
    | "NO_SUBJECT"
    | "ALREADY_WELL_FRAMED"
    | "WOULD_CUT_SUBJECT"
    | "BORDER_CROSSES_PRODUCT"
    | "SUBJECT_TOO_LARGE_FOR_ASPECT";
  /** cropを適用した場合の、出力フレームに対する被写体の最大相対寸法。 */
  resultingSubjectExtent: number | null;
  shape: SubjectShape;
  /**
   * 画角に不要物(撮影機材など)が残っているか。
   *
   * 残っていても crop 自体は成立させる。消去はしないし(§5)、不要物を
   * 外すためだけに商品を切るのは優先順位が逆(付録B: ②切らない)。
   * 残った場合は要レビューの材料として上へ渡す(§42)。
   */
  avoidRegionIncluded?: boolean;
  /** 採用した切り口の、4辺のうち最も商品に掛かっている度合い。0.00が完全な背景。 */
  borderScore?: number;
  /** 実際に採用した出力比率。希望と違う場合がある(横長商品を正方形へ押し込まないため)。 */
  aspect?: OutputAspect;
}

function aspectValue(aspect: OutputAspect, srcW: number, srcH: number): number {
  if (aspect === "SQUARE_1_1") return 1;
  if (aspect === "LANDSCAPE_3_2") return 3 / 2;
  return srcW / srcH;
}

export function classifyShape(bbox: NormalizedRect, srcW: number, srcH: number): SubjectShape {
  const wPx = bbox.width * srcW;
  const hPx = bbox.height * srcH;
  const ratio = wPx / Math.max(1, hPx);
  if (ratio >= 1.6) return "WIDE";
  if (ratio <= 0.75) return "TALL";
  return "BALANCED";
}

/**
 * 切り出し矩形を決める。
 *
 * 手順:
 *  1. 被写体bboxへ余白を足した「絶対に含めたい領域」を作る。
 *     下側は影と接地面を残すため厚めにする。
 *  2. 目標占有率から、その領域を包む出力フレームの大きさを決める。
 *  3. 出力比率に合わせて縦横を整え、被写体の中心へ寄せる。
 *     ただし縦方向は、上に空きすぎないよう接地点をやや下寄りに置く。
 *  4. 元画像の内側へ収める。収める過程で必要な領域が入りきらないなら、
 *     拡大率を落とす。それでも入らなければcropしない。
 */
export function planCrop(
  analysis: ImageAnalysis,
  aspect: OutputAspect,
  targets: CropTargets = DEFAULT_CROP_TARGETS,
  /**
   * 画角から外したい領域(撮影機材など)。AI Visionが見つけたときだけ入る。
   * 空のときの挙動は従来と完全に同じ。
   */
  avoidRegions: NormalizedRect[] = [],
): CropPlan {
  const srcW = analysis.width;
  const srcH = analysis.height;
  const full: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 };
  const bbox0 = analysis.subject.bbox;
  const shape = bbox0 ? classifyShape(bbox0, srcW, srcH) : "BALANCED";

  if (!bbox0) return { rect: full, applied: false, reason: "NO_SUBJECT", resultingSubjectExtent: null, shape };
  if (analysis.subject.confidence < MIN_CROP_CONFIDENCE) {
    return { rect: full, applied: false, reason: "LOW_CONFIDENCE", resultingSubjectExtent: null, shape };
  }

  // 出力比率は希望であって強制ではない。
  //
  // 理想写真4枚を見ると、人間は椅子と丸テーブル(単体でまとまった形)を
  // 1:1で、ピンクチェア+サイドテーブルと横長ソファを4:3で仕上げていた。
  // 横長の商品を正方形へ押し込むと、端が枠に接するか切れてしまう。
  // 仕様§8の「商品が横長すぎて正方形が不適切なら無理に切らない」に従い、
  // 希望比率で良い構図が取れなければ横長へ落とす。
  const candidates: OutputAspect[] = aspect === "ORIGINAL" ? ["ORIGINAL"] : [aspect, "LANDSCAPE_3_2", "SQUARE_1_1"];

  // 候補を順番に「最初に成功したもの」で決めない。比率によって商品の
  // 見え方が大きく変わるため、**商品が最も大きく写る**案を選ぶ。
  // (横長を優先する固定順にしたところ、ソファが3:2で選ばれて正方形より
  //  小さく写るという逆効果が実測で出た。)
  let best: CropPlan | null = null;
  let lastFailure: CropPlan | null = null;
  const seen = new Set<OutputAspect>();
  for (const candidateAspect of candidates) {
    if (seen.has(candidateAspect)) continue;
    seen.add(candidateAspect);
    const plan = planCropForAspect(analysis, aspectValue(candidateAspect, srcW, srcH), targets, srcW, srcH, shape, full);
    if (!plan.applied) { lastFailure = plan; continue; }
    const includesAvoid = avoidRegions.length > 0 && cropIncludesAvoidRegion(plan.rect, avoidRegions);
    const withAspect = { ...plan, aspect: candidateAspect, avoidRegionIncluded: includesAvoid };
    if (!best || isBetterPlan(withAspect, best)) best = withAspect;
  }
  if (best) return best;
  return lastFailure ?? { rect: full, applied: false, reason: "NO_SUBJECT", resultingSubjectExtent: null, shape };
}

/**
 * どちらの構図案を採るか。
 *
 * 不要物を画角外にできる案を優先し、その中で商品が最も大きく写る案を選ぶ。
 * 「不要物を外す」を「商品を大きく」より先に見るのは、機材が写り込んだ
 * 写真は寄っていても商品写真として使えないため(§5)。ただし不要物を
 * 外すために商品を切ることはしない — 切る案はそもそもここへ来ない。
 */
function isBetterPlan(candidate: CropPlan, best: CropPlan): boolean {
  const cClean = !candidate.avoidRegionIncluded;
  const bClean = !best.avoidRegionIncluded;
  if (cClean !== bClean) return cClean;
  return (candidate.resultingSubjectExtent ?? 0) > (best.resultingSubjectExtent ?? 0);
}

/** 1つの比率について、切り口が商品に掛からない構図を探す。 */
function planCropForAspect(
  analysis: ImageAnalysis,
  targetAspect: number,
  targets: CropTargets,
  srcW: number,
  srcH: number,
  shape: SubjectShape,
  full: NormalizedRect,
): CropPlan {

  // 目標の寄りを少しずつ緩めながら、切り口が商品を横切らない案を探す。
  // bboxの精度だけに頼らないための安全装置(§27)。
  for (let attempt = 0; attempt < 8; attempt++) {
    const relaxed: CropTargets = { ...targets, maxSubjectExtent: targets.maxSubjectExtent * (1 - attempt * 0.08) };
    const candidate = planCropOnce(analysis, targetAspect, relaxed, srcW, srcH, shape);
    if (!candidate.applied) {
      // 寄りを緩めても成立しない理由(被写体が大きすぎる等)は緩めても変わらない。
      if (candidate.reason !== "BORDER_CROSSES_PRODUCT") return candidate;
      continue;
    }
    const edge = borderLikelihood(analysis.subject.likelihood, candidate.rect);
    // このスタジオ背景では、壁も床も尤度が実測でちょうど0.00になる。
    // したがって切り口に非ゼロの信号があれば「そこに何かある」を意味する。
    // 白い天板のように検出の弱い部位は0.04程度しか立たないので、閾値を
    // 高く取ると切ってしまう(実際、ピンクチェアの左にある白いテーブルを
    // 切っていた)。切るくらいなら寄らない、という優先順位に従う。
    if (edge < 0.03) return { ...candidate, borderScore: edge };
  }
  return { rect: full, applied: false, reason: "BORDER_CROSSES_PRODUCT", resultingSubjectExtent: null, shape };
}

/** 1回ぶんの構図案を作る。呼び出し側が目標を緩めながら繰り返す。 */
function planCropOnce(
  analysis: ImageAnalysis,
  targetAspect: number,
  targets: CropTargets,
  srcW: number,
  srcH: number,
  shape: SubjectShape,
): CropPlan {
  const full: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 };
  const bbox = analysis.subject.bbox;
  if (!bbox) return { rect: full, applied: false, reason: "NO_SUBJECT", resultingSubjectExtent: null, shape };

  // 被写体をピクセル座標へ。以降は元画像のピクセルで考える。
  const sx0 = bbox.x * srcW;
  const sy0 = bbox.y * srcH;
  const sx1 = (bbox.x + bbox.width) * srcW;
  const sy1 = (bbox.y + bbox.height) * srcH;
  const sW = sx1 - sx0;
  const sH = sy1 - sy0;
  if (sW <= 2 || sH <= 2) {
    return { rect: full, applied: false, reason: "NO_SUBJECT", resultingSubjectExtent: null, shape };
  }

  // 目標: 被写体の長辺が出力フレームのmaxSubjectExtentを占める。
  // 出力フレームの大きさ(ピクセル)をそこから逆算する。
  const subjectLong = Math.max(sW, sH);
  const isSubjectWide = sW >= sH;
  // 長辺が縦か横かで、フレームのどちらの辺に合わせるかが変わる。
  let frameW: number;
  let frameH: number;
  if (isSubjectWide) {
    frameW = subjectLong / targets.maxSubjectExtent;
    frameH = frameW / targetAspect;
  } else {
    frameH = subjectLong / targets.maxSubjectExtent;
    frameW = frameH * targetAspect;
  }

  // 最低余白と床余白を満たすのに必要な最小フレームも確認する。
  const needW = sW / (1 - 2 * targets.minMarginRatio);
  const needH = sH / (1 - targets.minMarginRatio - targets.floorMarginRatio);
  if (frameW < needW) { frameW = needW; frameH = frameW / targetAspect; }
  if (frameH < needH) { frameH = needH; frameW = frameH * targetAspect; }

  // 元画像より大きいフレームは作れない(canvasを広げない)。縮めて収める。
  const scale = Math.min(1, srcW / frameW, srcH / frameH);
  frameW *= scale;
  frameH *= scale;

  // 縮めた結果、被写体が入りきらない/余白が確保できないなら、cropしない。
  if (frameW < sW + 2 || frameH < sH + 2) {
    return { rect: full, applied: false, reason: "SUBJECT_TOO_LARGE_FOR_ASPECT", resultingSubjectExtent: null, shape };
  }

  // 配置: 横は被写体中心。縦は接地点を下寄りに置き、上に余白を多めに残す
  // (家具写真は頭上の空きが自然で、床を切ると浮いて見えるため)。
  const cx = (sx0 + sx1) / 2;
  let x = cx - frameW / 2;
  let y = sy1 + frameH * targets.floorMarginRatio - frameH;

  // 元画像の内側へ収める。
  x = Math.max(0, Math.min(srcW - frameW, x));
  y = Math.max(0, Math.min(srcH - frameH, y));

  // 収めた結果、被写体を切っていないか必ず確認する。切るならcropしない。
  const cutsSubject = sx0 < x - 0.5 || sy0 < y - 0.5 || sx1 > x + frameW + 0.5 || sy1 > y + frameH + 0.5;
  if (cutsSubject) {
    return { rect: full, applied: false, reason: "WOULD_CUT_SUBJECT", resultingSubjectExtent: null, shape };
  }

  const resultingExtent = Math.max(sW / frameW, sH / frameH);

  // 元よりむしろ引きになる(＝被写体が小さくなる)なら、cropする意味がない。
  const currentExtent = Math.max(sW / srcW, sH / srcH);
  if (resultingExtent <= currentExtent * 1.02) {
    return { rect: full, applied: false, reason: "ALREADY_WELL_FRAMED", resultingSubjectExtent: currentExtent, shape };
  }

  return {
    rect: { x: x / srcW, y: y / srcH, width: frameW / srcW, height: frameH / srcH },
    applied: true,
    reason: "APPLIED",
    resultingSubjectExtent: resultingExtent,
    shape,
  };
}
