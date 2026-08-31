import { iou, overlapRatio, unionRect } from "./validate";
import type { NormalizedRect, VisionAnalysisResult, VisionTriggerReason } from "./types";

/**
 * AI Vision を呼ぶかどうかの判断と、返答の受け入れ方
 * （2026-08-31 AI Vision統合仕様書 §5 / §6 / §35 / §57）。
 *
 * 仕様は「全画像に無条件でAIを適用する設計は禁止」「AIは難例に対する
 * 意味解析フォールバック」と明示している。実際、暗所の丸テーブルは
 * 露出補正を検出の前へ動かすだけで占有率2.3%→8.6%(お手本9.9%)まで
 * 改善し、撮影機材のcrop除外もできた。AIはそこで決めきれない場合の
 * 補助であって、置き換えではない。
 */

/** ローカルの確信度がこれ以上なら、AIを呼ばない。 */
export const LOCAL_CONFIDENCE_SUFFICIENT = 0.55;

/** 極端に暗い写真はローカル解析が不利なので、確信度が中程度でも相談する。 */
export const DARK_SCENE_BACKGROUND_LUMINANCE = 70;

/** ローカルとAIの見立てが「同じものを見ている」とみなすIoUの下限。 */
export const AGREEMENT_IOU = 0.6;

/**
 * 「画面のほぼ全部が商品」という主張を受け入れない面積の下限。
 *
 * この大きさのbboxは構図の手がかりを何も与えない。全面をcropしても
 * 元のままだからである。にもかかわらず、確信度だけは高く返ってくる
 * ことがある(モデルが判断を放棄したときの典型的な答え)。
 *
 * お手本4枚の実測では、商品bboxの面積は画面の13%以下だった。
 * 仮に極端に寄った商品写真でも、長辺比0.77×0.77 ≒ 0.59が上限に近い。
 * 0.7を超える主張は「答えになっていない」として扱う。
 */
export const IMPLAUSIBLE_BBOX_AREA = 0.7;

/** 構図の判断材料として使えない大きさか。 */
function isUninformative(rect: NormalizedRect): boolean {
  return rect.width * rect.height >= IMPLAUSIBLE_BBOX_AREA;
}

export interface RoutingInput {
  localConfidence: number;
  hasLocalSubject: boolean;
  backgroundLuminance: number;
  /** 被写体が画面の端に接している。画角外に何かある可能性がある。 */
  subjectTouchesFrameEdge: boolean;
}

export interface RoutingDecision {
  useVision: boolean;
  reason: VisionTriggerReason | null;
}

/**
 * AIを呼ぶべきかを決める。
 *
 * 呼ばない判断を既定にする。コストと遅延がかかるうえ、ローカルで
 * 十分な確信が得られている画像にAIを足しても品質は上がらない(§56
 * 「AIを入れたこと自体を成果にしない」)。
 */
export function decideVisionRouting(input: RoutingInput): RoutingDecision {
  if (!input.hasLocalSubject) return { useVision: true, reason: "NO_LOCAL_SUBJECT" };
  if (input.localConfidence < 0.3) return { useVision: true, reason: "LOW_LOCAL_CONFIDENCE" };
  if (input.backgroundLuminance < DARK_SCENE_BACKGROUND_LUMINANCE && input.localConfidence < LOCAL_CONFIDENCE_SUFFICIENT) {
    return { useVision: true, reason: "DARK_SCENE" };
  }
  if (input.subjectTouchesFrameEdge && input.localConfidence < LOCAL_CONFIDENCE_SUFFICIENT) {
    return { useVision: true, reason: "SUSPECTED_IRRELEVANT_OBJECT" };
  }
  if (input.localConfidence < LOCAL_CONFIDENCE_SUFFICIENT) return { useVision: true, reason: "LOW_LOCAL_CONFIDENCE" };
  return { useVision: false, reason: null };
}

export interface MergedSubject {
  bbox: NormalizedRect | null;
  /** 構図決定に使う確信度。AIとの一致度で上下する。 */
  confidence: number;
  /** 画角から外したい領域。cropの評価に使う（消去はしない）。 */
  avoidRegions: NormalizedRect[];
  reasonCodes: string[];
}

/**
 * ローカルとAIの見立てを統合する。
 *
 * AIのbboxをそのまま採用しない(§7「AI座標を無条件採用せず再検証」)。
 * 大きく食い違うときは和集合を採り、確信度を下げる(§57)。緩い構図に
 * なるが、商品を切るより望ましい(付録B: ②切らない ＞ ⑥大きくする)。
 */
export function mergeVisionWithLocal(
  localBbox: NormalizedRect | null,
  localConfidence: number,
  vision: VisionAnalysisResult | null,
): MergedSubject {
  if (!vision) {
    return { bbox: localBbox, confidence: localConfidence, avoidRegions: [], reasonCodes: ["VISION_UNAVAILABLE"] };
  }
  const reasonCodes = ["AI_ASSISTED_CROP", ...vision.reasonCodes];
  const avoidRegions = vision.irrelevantObjects.map(({ x, y, width, height }) => ({ x, y, width, height }));

  if (!vision.productDetected || !vision.productBbox) {
    // AIも商品を見つけられなかった。ローカルの見立てのまま、確信度は下げる。
    return {
      bbox: localBbox,
      confidence: Math.min(localConfidence, 0.4),
      avoidRegions,
      reasonCodes: [...reasonCodes, "AI_NO_PRODUCT"],
    };
  }

  // must_keep もAIの言い分なので、商品領域として取り込むが検証対象にする。
  let aiBbox: NormalizedRect | null = vision.productBbox;
  for (const keep of vision.mustKeepRegions) aiBbox = unionRect(aiBbox, keep);

  // 大きすぎる主張は、ローカルと突き合わせる前に弾く。
  //
  // ローカルが商品を見つけられなかった場合(NO_LOCAL_SUBJECT)は比較対象が
  // 無いため、以前はAIの座標をそのまま確信度0.6で採用していた。そこは
  // MIN_CROP_CONFIDENCE(0.45)を超えるので、「画面全体が商品」という
  // 答えのままcropへ進んでしまう。比較できないときこそ、答えそのものが
  // 成立しているかを見る必要がある(§7「AI座標を無条件採用しない」)。
  if (isUninformative(aiBbox as NormalizedRect)) {
    return {
      bbox: localBbox,
      confidence: Math.min(localConfidence, 0.4),
      avoidRegions,
      reasonCodes: [...reasonCodes, "AI_BBOX_IMPLAUSIBLE"],
    };
  }

  if (!localBbox) {
    return { bbox: aiBbox, confidence: Math.min(vision.confidence, 0.6), avoidRegions, reasonCodes };
  }

  // 一致度はIoUで測る。包含率だと「画面全体が商品」という最も危険な応答が
  // 1.0(完全一致)と判定されてしまう。大きさの食い違いを罰する必要がある。
  const agreement = iou(localBbox, aiBbox as NormalizedRect);
  if (agreement >= AGREEMENT_IOU) {
    // 見立てが一致。和集合で少し広めに取り、確信度を上げる。
    return {
      bbox: unionRect(localBbox, aiBbox),
      confidence: Math.max(localConfidence, Math.min(vision.confidence, 0.9)),
      avoidRegions,
      reasonCodes,
    };
  }

  // 大きく食い違う。どちらが正しいか決められないので保守側へ倒す。
  return {
    bbox: unionRect(localBbox, aiBbox),
    confidence: Math.min(localConfidence, vision.confidence, 0.45),
    avoidRegions,
    reasonCodes: [...reasonCodes, "AI_LOCAL_DISAGREEMENT"],
  };
}

/** cropが不要物を画角内に残しているか。残っていればNEEDS_REVIEWの材料になる（§42）。 */
export function cropIncludesAvoidRegion(crop: NormalizedRect, avoid: NormalizedRect[]): boolean {
  return avoid.some((r) => overlapRatio(crop, r) > 0.25);
}
