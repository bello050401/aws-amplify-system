/**
 * BELLO画像自動加工の品質ベンチマーク(2026-08-31 画像自動加工完全仕様書 §36)。
 *
 * 仕様は「今回提示された4組のBefore/Afterを、少なくとも手動QA benchmarkとして
 * 扱う」ことを求めている。ここではそれを機械化する — Beforeを実際に加工し、
 * その結果がAfter(＝人間が仕上げた理想)の方向へ動いているかを数値で見る。
 *
 * 画像の「美しさ」を自動で保証することはできない。できるのは、
 * 理想写真との差が **縮まっているか** を測ることだけである。
 * したがってこのスクリプトは合否ではなく、
 *
 *   Before の値 → 加工後の値 → After(理想)の値
 *
 * を並べて表示し、加工後がBeforeよりAfterへ近いかどうかを判定する。
 *
 * ## 参照画像について
 *
 * 4組の写真はユーザーの実商品写真なのでリポジトリへ入れない。
 * 既定では `C:/Users/win/Desktop/UI画像/新しいフォルダー` を見るが、
 * 環境変数 `BELLO_BENCHMARK_DIR` で差し替えられる。見つからない場合は
 * 失敗ではなくスキップする(CIや他の環境で落ちないように)。
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { analyzeImage, type RawImage } from "@/lib/imageProcessing/analysis";
import { SharpImageProcessingProvider } from "@/lib/imageProcessing/sharpProcessor";

const DEFAULT_DIR = "C:/Users/win/Desktop/UI画像/新しいフォルダー";
const DIR = process.env.BELLO_BENCHMARK_DIR || DEFAULT_DIR;
/** 加工結果を書き出す先。目視確認したいときだけ指定する。 */
const OUT_DIR = process.env.BELLO_BENCHMARK_OUT;

interface Pair {
  before: string;
  after: string;
  label: string;
  /** 仕様§36がこの組で特に確認せよと指定している点。 */
  focus: string;
}

const PAIRS: Pair[] = [
  { before: "S__34611229_0.jpg", after: "S__34611227_0.jpg", label: "椅子", focus: "全脚・背もたれ・アームを切らない / 正方形crop / 影と背景を残す" },
  { before: "S__34611230_0.jpg", after: "S__34611231_0.jpg", label: "ピンクチェア", focus: "明るくする / ピンクを蛍光化しない / 白天板のハイライト保護 / 金属の質感" },
  { before: "S__34611232_0.jpg", after: "S__34611233_0.jpg", label: "水色ソファ", focus: "ソファを大きく / ボタンとシワを保持 / 座面下の影を残す / 形を変えない" },
  { before: "S__34611234_0.jpg", after: "S__34611235_0.jpg", label: "丸テーブル", focus: "右の機材をcropで除外 / 天板を切らない / 白のハイライト制御 / 木脚の色" },
];

async function loadRaw(buf: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(buf)
    .rotate()
    .resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/** 主要な家具色が加工前後で保たれているか(§26 色差安全装置)。 */
async function dominantColor(buf: Buffer, rect: { x: number; y: number; w: number; h: number }): Promise<[number, number, number]> {
  const meta = await sharp(buf).metadata();
  const W = meta.width ?? 1;
  const H = meta.height ?? 1;
  const left = Math.max(0, Math.min(W - 2, Math.round(rect.x * W)));
  const top = Math.max(0, Math.min(H - 2, Math.round(rect.y * H)));
  const width = Math.max(1, Math.min(W - left, Math.round(rect.w * W)));
  const height = Math.max(1, Math.min(H - top, Math.round(rect.h * H)));
  const st = await sharp(buf).extract({ left, top, width, height }).stats();
  return [st.channels[0].mean, st.channels[1].mean, st.channels[2].mean];
}

function closer(beforeV: number, afterV: number, idealV: number): string {
  const dB = Math.abs(idealV - beforeV);
  const dA = Math.abs(idealV - afterV);
  if (dA < dB - 0.5) return "改善";
  if (dA > dB + 0.5) return "★悪化";
  return "変化なし";
}

async function main(): Promise<void> {
  if (!fs.existsSync(DIR)) {
    console.log(`[benchmark] 参照画像フォルダが見つからないためスキップ: ${DIR}`);
    console.log("[benchmark] BELLO_BENCHMARK_DIR で場所を指定できます。");
    return;
  }

  const provider = new SharpImageProcessingProvider();
  let regressions = 0;

  for (const pair of PAIRS) {
    const beforePath = path.join(DIR, pair.before);
    const afterPath = path.join(DIR, pair.after);
    if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) {
      console.log(`[benchmark] ${pair.label}: 画像が無いのでスキップ`);
      continue;
    }

    const beforeBuf = fs.readFileSync(beforePath);
    const idealBuf = fs.readFileSync(afterPath);

    const t0 = Date.now();
    const result = await provider.process({ sourceBuffer: beforeBuf, classification: "FULL", aspectRatio: "SQUARE_1_1" });
    const elapsed = Date.now() - t0;

    if (OUT_DIR) {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, `${pair.label}_加工後.jpg`), result.masterJpeg);
    }

    const [aBefore, aAfter, aIdeal] = await Promise.all([
      loadRaw(beforeBuf).then(analyzeImage),
      loadRaw(result.masterJpeg).then(analyzeImage),
      loadRaw(idealBuf).then(analyzeImage),
    ]);

    console.log(`\n=== ${pair.label} (${elapsed}ms) ===`);
    console.log(`  確認観点: ${pair.focus}`);
    console.log(`  crop: ${result.diagnostics.crop.reason} / 形状 ${result.diagnostics.crop.shape} / 出力 ${result.width}x${result.height} / 比率 ${result.diagnostics.crop.aspect ?? "-"} / 切り口 ${result.diagnostics.crop.borderScore?.toFixed(3) ?? "-"}`);

    const rows: [string, number, number, number][] = [
      ["被写体の占有率(%)", aBefore.subject.occupancy * 100, aAfter.subject.occupancy * 100, aIdeal.subject.occupancy * 100],
      ["背景の輝度", aBefore.background.medianLuminance, aAfter.background.medianLuminance, aIdeal.background.medianLuminance],
      ["周辺減光", aBefore.background.vignetteDrop, aAfter.background.vignetteDrop, aIdeal.background.vignetteDrop],
      ["白飛び(%)", aBefore.highlightClipRatio * 100, aAfter.highlightClipRatio * 100, aIdeal.highlightClipRatio * 100],
      ["黒潰れ(%)", aBefore.shadowClipRatio * 100, aAfter.shadowClipRatio * 100, aIdeal.shadowClipRatio * 100],
    ];
    console.log("  項目                加工前 →  加工後  (理想)   判定");
    for (const [name, b, a, ideal] of rows) {
      const verdict = closer(b, a, ideal);
      if (verdict === "★悪化") regressions++;
      console.log(`  ${name.padEnd(18)} ${b.toFixed(1).padStart(6)} → ${a.toFixed(1).padStart(6)}  (${ideal.toFixed(1).padStart(6)})  ${verdict}`);
    }

    // 商品色の保持: 被写体bboxの中心付近を測る。露出補正で明るくはなるが、
    // 色相が大きく回っていないことを見る(§26)。
    const bbox = aBefore.subject.bbox;
    if (bbox) {
      const inner = { x: bbox.x + bbox.width * 0.35, y: bbox.y + bbox.height * 0.3, w: bbox.width * 0.3, h: bbox.height * 0.3 };
      const cb = await dominantColor(beforeBuf, inner);
      const ca = await dominantColor(result.masterJpeg, { x: 0.35, y: 0.3, w: 0.3, h: 0.3 });
      const hue = (c: [number, number, number]) => {
        const sum = c[0] + c[1] + c[2] || 1;
        return [c[0] / sum, c[1] / sum, c[2] / sum];
      };
      const hb = hue(cb);
      const ha = hue(ca);
      const drift = Math.max(Math.abs(hb[0] - ha[0]), Math.abs(hb[1] - ha[1]), Math.abs(hb[2] - ha[2])) * 100;
      const ok = drift < 8;
      if (!ok) regressions++;
      console.log(`  商品色の色味ずれ ${drift.toFixed(1)}pt ${ok ? "(許容内 — 明るさは変わるが色相は保持)" : "★大きすぎる"}`);
    }

    for (const note of result.diagnostics.tone.notes) console.log(`   ・${note}`);
  }

  console.log(`\n${regressions === 0 ? "理想へ向かって改善しない項目はありませんでした。" : `★ ${regressions}件が理想から遠ざかりました。`}`);
}

void main();
