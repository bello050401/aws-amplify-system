/**
 * 画像加工パイプラインの実画像リグレッションゲート
 * （2026-08-31 AI Vision統合仕様書 §21「丸テーブルは必須ゲート」/ §36 / §46）。
 *
 * ベンチマーク(benchmark-image-processing.ts)は数値を並べて目視させる道具で、
 * 判定はしない。こちらは**閾値を割ったら落ちる**。仕様が「何もしない、を
 * 完了と呼ぶことを禁ずる」と書いている項目を機械が守るための番人である。
 *
 * 参照画像はユーザーの実商品写真なのでリポジトリに入っていない。
 * 見つからない場合はスキップする(CIや他環境で落ちないように)。
 * **スキップは合格ではない。** 報告時に必ず区別すること。
 *
 * Run with: npm run verify:image-pipeline
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { analyzeImage, type RawImage } from "@/lib/imageProcessing/analysis";
import { SharpImageProcessingProvider } from "@/lib/imageProcessing/sharpProcessor";
import { MockVisionAnalyzer, ROUND_TABLE_FIXTURE } from "@/lib/imageProcessing/vision/mockVisionAnalyzer";
import type { VisionAnalyzer } from "@/lib/imageProcessing/vision/types";

const DIR = process.env.BELLO_BENCHMARK_DIR || "C:/Users/win/Desktop/UI画像/新しいフォルダー";

/**
 * Before画像。対応はbenchmark-image-processing.tsのPAIRSと同一にすること
 * (撮影順とBefore/Afterの並びは一致しない — 取り違えると別の写真を
 *  「丸テーブル」として検証してしまう)。
 */
const CASES = [
  { name: "椅子", before: "S__34611229_0.jpg" },
  { name: "ピンクチェア", before: "S__34611230_0.jpg" },
  { name: "水色ソファ", before: "S__34611232_0.jpg" },
  { name: "丸テーブル", before: "S__34611234_0.jpg" },
] as const;

let failures = 0;
let passes = 0;

function check(ok: boolean, label: string, detail = "") {
  if (ok) { passes++; console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failures++; console.error(`✗ FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function occupancyOf(buf: Buffer): Promise<number> {
  const { data, info } = await sharp(buf)
    .resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const raw: RawImage = { data, width: info.width, height: info.height, channels: info.channels };
  return analyzeImage(raw).subject.occupancy;
}

async function run(source: Buffer, analyzer?: VisionAnalyzer) {
  const provider = new SharpImageProcessingProvider(analyzer ? { visionAnalyzer: analyzer } : {});
  return provider.process({ sourceBuffer: source, classification: "TOP", aspectRatio: "SQUARE_1_1" });
}

/**
 * ローカル解析が決めきれない画像を作る（白い商品を白い背景に置いた構図）。
 *
 * 参照写真4枚はどれも露出補正の後で確信度が足りてしまい、AIを呼ばない
 * ——それが正しい挙動である（§5）。しかしそれではAIを使う経路そのものが
 * 一度も動かないまま出荷されてしまうので、仕様が難例として名指ししている
 * white-on-whiteを合成して、経路を実際に通す。
 */
async function makeHardCase(): Promise<Buffer> {
  const W = 1600;
  const H = 900;
  const bg = Buffer.alloc(W * H * 3, 246);
  // 背景とほとんど差の無い明度で、四角い「商品」を置く。
  for (let y = Math.round(H * 0.42); y < Math.round(H * 0.78); y++) {
    for (let x = Math.round(W * 0.38); x < Math.round(W * 0.6); x++) {
      const i = (y * W + x) * 3;
      bg[i] = 240;
      bg[i + 1] = 239;
      bg[i + 2] = 238;
    }
  }
  return sharp(bg, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

/** AIを使う経路が実際に動くことを確認する（合成画像なので参照写真が無くても走る）。 */
async function verifyVisionPath(): Promise<void> {
  const hard = await makeHardCase();

  const plain = await run(hard);
  check(!plain.diagnostics.vision.requested || !plain.diagnostics.vision.applied,
    "AI経路: analyzerを渡さなければAIは一切使われない");

  const mock = new MockVisionAnalyzer(() => ROUND_TABLE_FIXTURE);
  const assisted = await run(hard, mock);
  const v = assisted.diagnostics.vision;

  check(v.requested, "AI経路: 難例と判断してAIへ相談する", v.trigger ?? "(トリガー無し)");
  check(mock.calls === 1, "AI経路: 相談は1回だけ", `${mock.calls}回`);
  check(v.applied, "AI経路: 検証を通った応答を採用する");
  check(v.modelId !== null && v.latencyMs !== null, "AI経路: どのモデルで何msかかったかを記録する", `${v.modelId} / ${v.latencyMs}ms`);
  check(v.reasonCodes.includes("AI_ASSISTED_CROP"), "AI経路: AIを使ったことが理由コードに残る", v.reasonCodes.join(","));
  check(v.avoidRegions.length === 1, "AI経路: 不要物(撮影機材)が回避領域として渡る");
  check(assisted.readBackVerified, "AI経路: 生成物が読み戻せる");

  // AIの座標を無条件に信じない（§7）。ローカルと食い違えば確信度を下げる。
  const conflicting = new MockVisionAnalyzer(() =>
    JSON.stringify({ product_detected: true, confidence: 0.99, product_bbox: { x: 0, y: 0, width: 1, height: 1 } }),
  );
  const conflicted = await run(hard, conflicting);
  check(
    conflicted.diagnostics.analysis.subject.confidence <= 0.45,
    "AI経路: 画面全体を商品と主張されても盲信せず確信度を下げる",
    `確信度 ${conflicted.diagnostics.analysis.subject.confidence.toFixed(2)}`,
  );
  check(conflicted.readBackVerified, "AI経路: 食い違っても加工は完了する");

  // AIが落ちても、AIを渡さなかったときと同じ結果になること。
  const broken = await run(hard, new MockVisionAnalyzer(() => new Error("VISION_TIMEOUT")));
  check(broken.masterJpeg.equals(plain.masterJpeg), "AI経路: AI障害時はAI無しと同一の結果になる");
}

async function main(): Promise<void> {
  await verifyVisionPath();

  if (!fs.existsSync(DIR)) {
    console.log(`[skip] 参照画像が見つかりません (${DIR})。BELLO_BENCHMARK_DIR で指定できます。`);
    console.log("SKIPPED — これは合格ではない。");
    return;
  }

  const sources = new Map<string, Buffer>();
  for (const c of CASES) {
    const p = path.join(DIR, c.before);
    if (!fs.existsSync(p)) { console.log(`[skip] ${c.name}: ${c.before} が無い`); continue; }
    sources.set(c.name, fs.readFileSync(p));
  }
  if (sources.size === 0) { console.log("SKIPPED — 参照画像なし。合格ではない。"); return; }

  // --- 1. 4枚すべてが加工でき、読み戻せる（fake successを作らない） ---
  const baseline = new Map<string, Awaited<ReturnType<typeof run>>>();
  for (const [name, buf] of sources) {
    const r = await run(buf);
    baseline.set(name, r);
    check(r.readBackVerified, `${name}: 生成した3種のバッファを読み戻せる`);
    check(r.width > 0 && r.height > 0, `${name}: 出力寸法が有効`, `${r.width}x${r.height}`);
    check(!r.floorCleanupApplied, `${name}: 床クリーニングは未実装として偽装しない`);
  }

  // --- 2. 白飛び・黒潰れを作らない（情報を捨てない） ---
  for (const [name, r] of baseline) {
    const after = analyzeImage(await (async () => {
      const { data, info } = await sharp(r.masterJpeg)
        .resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true })
        .removeAlpha().raw().toBuffer({ resolveWithObject: true });
      return { data, width: info.width, height: info.height, channels: info.channels } as RawImage;
    })());
    check(after.highlightClipRatio <= 0.02, `${name}: 白飛びが2%以下`, `${(after.highlightClipRatio * 100).toFixed(1)}%`);
    check(after.shadowClipRatio <= 0.02, `${name}: 黒潰れが2%以下`, `${(after.shadowClipRatio * 100).toFixed(1)}%`);
  }

  // --- 3. 丸テーブル: 必須ゲート（§21「何もしない、を完了と呼ばない」） ---
  const table = baseline.get("丸テーブル");
  if (table) {
    const d = table.diagnostics;
    check(d.crop.applied, "丸テーブル: 構図を実際に変えている（NO-OPを完了と呼ばない）", d.crop.reason);
    const occ = await occupancyOf(table.masterJpeg);
    // お手本は9.9%。露出補正を検出の前へ動かして8.6〜8.7%まで来ている。
    check(occ >= 0.07, "丸テーブル: 被写体占有率が7%以上（お手本9.9%）", `${(occ * 100).toFixed(1)}%`);
    check(d.analysis.background.medianLuminance < 70, "丸テーブル: 元画像が暗所であることを前提にしている", `${d.analysis.background.medianLuminance.toFixed(0)}`);
    // 右端の撮影機材が画角から外れていること。
    const right = d.crop.rect.x + d.crop.rect.width;
    check(right <= 0.84, "丸テーブル: 右端の撮影機材(x≧0.84)をcropで除外", `crop右端 ${right.toFixed(3)}`);
  }

  // --- 4. ピンクチェア: 白いサイドテーブルを切らない ---
  const pink = baseline.get("ピンクチェア");
  if (pink) {
    const d = pink.diagnostics;
    check(d.crop.applied, "ピンクチェア: 構図を実際に変えている", d.crop.reason);
    // 切り口に商品の信号が乗っていないこと。実測で白天板は0.04程度しか立たない。
    check((d.crop.borderScore ?? 1) < 0.03, "ピンクチェア: 切り口が商品を横切っていない", `切り口 ${(d.crop.borderScore ?? 1).toFixed(3)}`);
  }

  // --- 5. AI障害時に加工が止まらない（§36） ---
  const probe = sources.get("丸テーブル") ?? [...sources.values()][0];
  const failing: Array<[string, VisionAnalyzer]> = [
    ["例外を投げる", new MockVisionAnalyzer(() => new Error("VISION_TIMEOUT"))],
    ["壊れたJSONを返す", new MockVisionAnalyzer(() => '{"product_detected": tr')],
    ["利用不可", new MockVisionAnalyzer(() => null)],
    ["自然文だけ返す", new MockVisionAnalyzer(() => "テーブルが写っています")],
  ];
  const withoutAi = await run(probe);
  for (const [label, analyzer] of failing) {
    let ok = false;
    let same = false;
    try {
      const r = await run(probe, analyzer);
      ok = r.readBackVerified && r.masterJpeg.length > 0;
      // AIの助けが無かったのだから、AI無しの結果と一致するはず。
      same = r.masterJpeg.equals(withoutAi.masterJpeg);
    } catch {
      ok = false;
    }
    check(ok, `AI障害(${label}): 加工が完了する`);
    check(same, `AI障害(${label}): AI無しと同じ結果になる（勝手に劣化させない）`);
  }

  // --- 6. AIを常に呼ぶ設計になっていない（§5 / §35 コスト） ---
  const counter = new MockVisionAnalyzer(() => ROUND_TABLE_FIXTURE);
  for (const buf of sources.values()) await run(buf, counter);
  check(
    counter.calls < sources.size,
    "AIを全画像で呼んでいない（難例だけに使う）",
    `${counter.calls}/${sources.size} 枚で呼び出し`,
  );

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exitCode = 1;
}

void main();
