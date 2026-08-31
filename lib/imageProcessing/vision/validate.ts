import type { LabeledRect, NormalizedRect, VisionAnalysisResult } from "./types";

/**
 * AI応答の検証（2026-08-31 AI Vision統合仕様書 §7 / §36 / §57）。
 *
 * AIの出力をそのまま画像処理へ渡してはいけない。仕様は
 * 「AI座標を無条件採用せずlocal engineで再検証」「不正JSONは
 * validatorで拒否しunsafe cropを禁止」と明示している。
 *
 * ここは**受け入れるか捨てるか**だけを決める。壊れた応答は
 * `null` になり、呼び出し側はAIの助けが無かったものとして進む。
 * 中途半端に補完して「それらしい値」を作らない — 座標を1つ推測で
 * 埋めるだけで商品を切る構図が通ってしまう。
 */

const SCHEMA_VERSION = 1;

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** 0..1 に収まる矩形か。NaN/Infinity/負の幅/画面外は弾く。 */
function parseRect(raw: unknown): NormalizedRect | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const { x, y, width, height } = r;
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  // 多少のはみ出しは丸めて受け入れるが、大きくずれているものは捨てる。
  if (x < -0.02 || y < -0.02 || x + width > 1.02 || y + height > 1.02) return null;
  const cx = Math.max(0, Math.min(1, x));
  const cy = Math.max(0, Math.min(1, y));
  return {
    x: cx,
    y: cy,
    width: Math.max(0.001, Math.min(1 - cx, width)),
    height: Math.max(0.001, Math.min(1 - cy, height)),
  };
}

function parseLabeledRects(raw: unknown, max = 8): LabeledRect[] {
  if (!Array.isArray(raw)) return [];
  const out: LabeledRect[] = [];
  for (const entry of raw.slice(0, max)) {
    const rect = parseRect(entry);
    if (!rect) continue;
    const label = typeof (entry as Record<string, unknown>).label === "string" ? String((entry as Record<string, unknown>).label).slice(0, 60) : "";
    out.push({ ...rect, label });
  }
  return out;
}

/**
 * モデルの応答テキストからJSONを取り出す。
 *
 * 構造化出力を指示しても、前後に説明文やコードフェンスが付くことがある。
 * 最初の `{` から最後の `}` までを取るだけの素朴な抽出に留め、
 * 直せなかったものは捨てる（無理に修復しない）。
 */
export function extractJson(text: string): unknown {
  if (typeof text !== "string") return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

export interface ValidateOptions {
  modelId: string;
  latencyMs: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

/**
 * 応答を検証済みの結果へ変換する。受け入れられなければ null。
 *
 * 「商品が見つからなかった」という応答自体は正常（productDetected:false）。
 * null になるのは、構造が壊れていて**判断材料として使えない**場合だけ。
 */
export function validateVisionResponse(raw: unknown, opts: ValidateOptions): VisionAnalysisResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  if (typeof r.product_detected !== "boolean") return null;
  const confidence = finite(r.confidence) ? Math.max(0, Math.min(1, r.confidence)) : null;
  if (confidence === null) return null;

  const productBbox = r.product_detected ? parseRect(r.product_bbox) : null;
  // 「商品を検出した」と言いながら座標が壊れている応答は使えない。
  if (r.product_detected && !productBbox) return null;

  const aspectRaw = typeof r.recommended_aspect === "string" ? r.recommended_aspect : null;
  const recommendedAspect = aspectRaw === "SQUARE_1_1" || aspectRaw === "LANDSCAPE_3_2" ? aspectRaw : null;

  const reasonCodes = Array.isArray(r.reason_codes)
    ? r.reason_codes.filter((c): c is string => typeof c === "string").slice(0, 12).map((c) => c.slice(0, 60))
    : [];

  return {
    productDetected: r.product_detected,
    productType: typeof r.product_type === "string" ? r.product_type.slice(0, 60) : null,
    confidence,
    productBbox,
    mustKeepRegions: parseLabeledRects(r.must_keep_regions),
    irrelevantObjects: parseLabeledRects(r.irrelevant_objects),
    recommendedAspect,
    reasonCodes,
    modelId: opts.modelId,
    latencyMs: opts.latencyMs,
    inputTokens: opts.inputTokens ?? null,
    outputTokens: opts.outputTokens ?? null,
  };
}

/**
 * ローカルとAIのbboxが大きく食い違うときの扱い（§57）。
 *
 * どちらが正しいか決められないので、**和集合**を採る。切るリスクの
 * ある側へ倒さない、という優先順位（付録B: ②切らない ＞ ⑥大きくする）
 * に従った選択で、結果として構図は緩くなる。
 */
export function unionRect(a: NormalizedRect | null, b: NormalizedRect | null): NormalizedRect | null {
  if (!a) return b;
  if (!b) return a;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.width, b.x + b.width);
  const y1 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function intersectionArea(a: NormalizedRect, b: NormalizedRect): number {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return ix * iy;
}

/**
 * 小さい方に対する重なり率。「この矩形はあちらを含んでいるか」を見る用途。
 * cropが不要物を画角内に残していないかの判定に使う。
 */
export function overlapRatio(a: NormalizedRect, b: NormalizedRect): number {
  const smaller = Math.min(a.width * a.height, b.width * b.height);
  return smaller > 0 ? intersectionArea(a, b) / smaller : 0;
}

/**
 * IoU（重なり ÷ 和集合）。ローカルとAIの見立てが一致しているかの判定に使う。
 *
 * 包含率(overlapRatio)を一致判定に使ってはいけない。AIが「画面全体が商品」
 * と返した場合、ローカルの小さなbboxは完全に含まれるので包含率は1.0になり、
 * **最も危険な応答が「完全に一致」と判定されてしまう**。テストで実際に
 * この誤判定が出た。大きさの食い違いを罰するIoUが正しい。
 */
export function iou(a: NormalizedRect, b: NormalizedRect): number {
  const inter = intersectionArea(a, b);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

export { SCHEMA_VERSION };
