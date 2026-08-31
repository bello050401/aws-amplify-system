/**
 * BELLO画像自動加工 — 被写体・背景の解析(2026-08-31 画像自動加工完全仕様書 §5.2 / Stage 1)。
 *
 * ## なぜこのファイルが必要か
 *
 * 従来の加工は実質「EXIF回転 → 白帯付きリサイズ → 再エンコード」だけだった。
 * `sharpProcessor.ts`が`fit:"contain"`で目標比率へ合わせていたため、16:9の
 * 元画像を3:2や1:1へ入れると**白帯が足されて家具はむしろ小さくなり**、
 * トーン補正は`DEFAULT_ADJUSTMENTS`(恒等変換)のまま素通りしていた。
 * 提示されたBefore/Afterが求める「家具を大きく」「周辺の暗さを解除」
 * 「紫かぶりを取る」は、構造上ひとつも起きていなかった。
 *
 * ## このモジュールの立場
 *
 * ここは**解析だけ**を行う。ピクセルを1つも生成・修正しない
 * (仕様§1.1「このシステムは画像生成AIではない」)。出力は「どこに家具が
 * あるか」「背景はどのくらいの明るさか」「周辺減光はどれだけか」といった
 * 測定値で、実際の補正は`toneMap.ts`/`cropPlanner.ts`が使う。
 *
 * MLモデルは使わない。BELLOのスタジオ撮影は「白〜薄灰の無地の壁と白い床」
 * という強い前提があり、その前提を使った決定論的な推定で足りるため
 * (仕様はML利用を分析用途に限って許容しているが、必須とはしていない)。
 * 決定論的であることは、同じ画像から常に同じ加工が再現できるという
 * 可逆性の要件(§1.3)にも効く。
 *
 * ## 依存
 *
 * sharpを含む一切の画像ライブラリへ依存しない。生のRGBバイト列を受け取る
 * 純粋関数の集合なので、Lambdaへ持ち込んでもバンドルが太らず、テストから
 * 直接呼べる(`lib/ai/gateway/types.ts`やpipeline.tsと同じ方針)。
 */

/** デコード済みの生ピクセル。`channels`は3(RGB)を想定する。 */
export interface RawImage {
  data: Uint8Array | Buffer;
  width: number;
  height: number;
  channels: number;
}

/** 正規化座標(0..1)の矩形。左上原点。 */
export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BackgroundStats {
  /** 背景(無彩色)と判定された画素の輝度中央値(0..255)。 */
  medianLuminance: number;
  /** 背景画素の輝度5パーセンタイル。周辺減光の底を表す。 */
  p05Luminance: number;
  /** 背景画素の輝度95パーセンタイル。壁のハイライト側。 */
  p95Luminance: number;
  /** 背景画素のR/G/B平均。色かぶりの推定に使う。 */
  meanR: number;
  meanG: number;
  meanB: number;
  /**
   * 周辺減光の強さ。中央付近の背景輝度 - 四隅付近の背景輝度(0..255)。
   * 正の値が大きいほど「周辺が暗い」。提示されたBefore画像では
   * 実測で70〜140程度あった。
   */
  vignetteDrop: number;
}

export interface SubjectAnalysis {
  /** 家具と推定した領域。見つからなければnull。 */
  bbox: NormalizedRect | null;
  /**
   * 推定の確からしさ(0..1)。低いときは危険な自動cropをしない(§27)。
   * 「被写体マスクが1つのまとまりとして素直に取れたか」を表す。
   */
  confidence: number;
  /** 画面に対する被写体の面積比(0..1)。Afterでこれが上がることが品質改善の主指標。 */
  occupancy: number;
  /** 接地しているとみなせる最下端のy(正規化)。影の扱いに使う。 */
  floorContactY: number | null;
  /**
   * 粗い被写体尤度マップ(0..1)。cropの切り口が商品を横切っていないかを
   * 検査するために持つ。
   *
   * bboxだけを信じてcropすると、検出に失敗した部位を切ってしまう。実際、
   * ピンクチェアの組では左側の白いテーブルが「白い床と輝度が近く彩度も低い」
   * ために被写体と判定されず、cropがテーブルを切断した。理想写真では
   * テーブル全体が入っている。bboxの精度に頼らず、切り口そのものを
   * 見張るための材料。
   */
  likelihood: { grid: Float32Array; cols: number; rows: number };
}

export interface ImageAnalysis {
  width: number;
  height: number;
  background: BackgroundStats;
  subject: SubjectAnalysis;
  /** 画像全体の輝度中央値。露出補正の出発点。 */
  overallMedianLuminance: number;
  /** 白飛び画素の割合(0..1)。 */
  highlightClipRatio: number;
  /** 黒潰れ画素の割合(0..1)。 */
  shadowClipRatio: number;
  /** 画像全体の輝度95パーセンタイル。露出を上げられる余地の上限を決めるのに使う。 */
  overallP95Luminance: number;
}

/** ITU-R BT.601の輝度。整数演算で十分な精度。 */
export function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * 彩度の代用値(0..255)。max-min は HSV の彩度 × max に相当する。
 * 「壁や床のような無彩色か、家具のような有彩色か」を分けるだけなので
 * 正確なHSV変換までは要らない。黒い布や濃い木部はこの値が小さいが、
 * そちらは輝度差の側で拾う。
 */
export function chroma(r: number, g: number, b: number): number {
  return Math.max(r, g, b) - Math.min(r, g, b);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}

/**
 * 背景の輝度を粗いグリッドで推定する。
 *
 * 各セルの中で「彩度が低い＝壁/床らしい」画素だけを集めてその中央値を取る。
 * 家具で埋まったセルは有効画素が少なくなるので、そのセルは穴として残し、
 * 後段で近傍セルから埋める。こうして得られる低周波の輝度面が、そのまま
 * **照明ムラ・周辺減光のマップ**になる。
 *
 * 「背景を真っ白に塗る」ためではなく、「この画素の“本来の背景の明るさ”は
 * どれくらいか」を知って被写体を切り分けるための土台である。
 */
export function estimateBackgroundField(img: RawImage, grid = 12): { field: number[]; cols: number; rows: number; observed: boolean[] } {
  const { data, width, height, channels } = img;
  const cols = grid;
  const rows = Math.max(3, Math.round((grid * height) / Math.max(1, width)));
  const cellW = width / cols;
  const cellH = height / rows;
  const field: number[] = new Array(cols * rows).fill(NaN);

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.floor(cx * cellW);
      const x1 = Math.min(width, Math.ceil((cx + 1) * cellW));
      const y0 = Math.floor(cy * cellH);
      const y1 = Math.min(height, Math.ceil((cy + 1) * cellH));
      const lows: number[] = [];
      // セル内は間引いて走査する(2px刻み)。中央値の推定には十分で、
      // 4000x3000級の画像でも実用速度に収まる。
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const i = (y * width + x) * channels;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          if (chroma(r, g, b) <= 18) lows.push(luminance(r, g, b));
        }
      }
      if (lows.length >= 8) {
        lows.sort((a, b) => a - b);
        field[cy * cols + cx] = percentile(lows, 0.5);
      }
    }
  }

  // 穴埋め: 有効な近傍セルの平均で埋める。数回繰り返して内側まで伝播させる。
  for (let pass = 0; pass < 6; pass++) {
    let filled = 0;
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const idx = cy * cols + cx;
        if (!Number.isNaN(field[idx])) continue;
        let sum = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            const v = field[ny * cols + nx];
            if (!Number.isNaN(v)) { sum += v; n++; }
          }
        }
        if (n > 0) { field[idx] = sum / n; filled++; }
      }
    }
    if (filled === 0) break;
  }
  // それでも埋まらない(＝低彩度画素が極端に少ない)場合は全体中央値で埋める。
  const observed = field.map((v) => !Number.isNaN(v));
  const known = field.filter((v) => !Number.isNaN(v));
  const fallback = known.length ? known.slice().sort((a, b) => a - b)[Math.floor(known.length / 2)] : 128;
  for (let i = 0; i < field.length; i++) if (Number.isNaN(field[i])) field[i] = fallback;

  return { field, cols, rows, observed };
}

/** グリッドを双一次補間して、任意座標の背景輝度を返す。 */
export function sampleField(field: number[], cols: number, rows: number, u: number, v: number): number {
  const fx = Math.min(cols - 1, Math.max(0, u * cols - 0.5));
  const fy = Math.min(rows - 1, Math.max(0, v * rows - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(cols - 1, x0 + 1), y1 = Math.min(rows - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  const a = field[y0 * cols + x0], b = field[y0 * cols + x1];
  const c = field[y1 * cols + x0], d = field[y1 * cols + x1];
  return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
}

/**
 * 背景の統計。周辺減光は「中央付近の背景輝度 - 四隅付近の背景輝度」で測る。
 * 背景フィールドから読むので、家具の明暗に引きずられない。
 */
export function analyzeBackground(
  img: RawImage,
  fieldInfo: { field: number[]; cols: number; rows: number; observed?: boolean[] },
): BackgroundStats {
  const { data, width, height, channels } = img;
  const lums: number[] = [];
  let sr = 0, sg = 0, sb = 0, n = 0;
  const step = Math.max(1, Math.floor(Math.min(width, height) / 200));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * channels;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (chroma(r, g, b) > 18) continue; // 有彩色＝家具側とみなして除外
      lums.push(luminance(r, g, b));
      sr += r; sg += g; sb += b; n++;
    }
  }
  lums.sort((a, b) => a - b);

  const { field, cols, rows, observed } = fieldInfo;
  // 周辺減光 = 「中心寄りの背景」-「周辺寄りの背景」。
  //
  // 穴埋めしたセルを混ぜてはいけない。被写体が中央に大きく写っている
  // (＝まさに目標とする構図)ほど中央セルは実測できず、埋めた値で比べると
  // 減光量の符号が逆転する。実測で、加工後の椅子/丸テーブルが「周辺減光
  // -108 / -91」という有り得ない値になったのがこれ。実測できたセルだけを
  // 半径で2群に分け、どちらかが少なすぎるときは0(不明)を返す。
  const near: number[] = [];
  const far: number[] = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const idx = cy * cols + cx;
      if (observed && !observed[idx]) continue;
      const u = (cx + 0.5) / cols - 0.5;
      const v = (cy + 0.5) / rows - 0.5;
      const radius = Math.sqrt(u * u + v * v) / Math.SQRT1_2; // 0(中心)..1(隅)
      if (radius <= 0.45) near.push(field[idx]);
      else if (radius >= 0.75) far.push(field[idx]);
    }
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const vignetteDrop = near.length >= 3 && far.length >= 3 ? mean(near) - mean(far) : 0;

  return {
    medianLuminance: percentile(lums, 0.5),
    p05Luminance: percentile(lums, 0.05),
    p95Luminance: percentile(lums, 0.95),
    meanR: n ? sr / n : 128,
    meanG: n ? sg / n : 128,
    meanB: n ? sb / n : 128,
    vignetteDrop,
  };
}

/**
 * 家具領域の推定。
 *
 * 各画素を「背景フィールドから見て暗い」または「有彩色」なら被写体候補と
 * する。周辺減光は背景フィールド側に含まれているので、四隅が暗いことを
 * 家具と誤認しない — これが素朴な閾値処理との決定的な差で、Before画像の
 * ように隅が真っ黒に近い写真でも成立する。
 *
 * まとまりの判定は行/列の射影で行う。BELLOのスタジオ写真は「無地の背景に
 * 家具が1つ」という構図なので、連結成分ラベリングまで持ち出す必要がない。
 * ただし、射影がなだらかで山が立たない(＝背景と被写体を分離できていない)
 * 場合はconfidenceを下げ、呼び出し側が保守的に倒せるようにする。
 */
export function analyzeSubject(img: RawImage, fieldInfo: { field: number[]; cols: number; rows: number }): SubjectAnalysis {
  const { data, width, height, channels } = img;
  const { field, cols, rows } = fieldInfo;
  const step = Math.max(1, Math.floor(Math.min(width, height) / 400));
  const colScore = new Float64Array(Math.ceil(width / step));
  const rowScore = new Float64Array(Math.ceil(height / step));
  let subjectPixels = 0, totalPixels = 0;
  const LCOLS = 48;
  const LROWS = Math.max(8, Math.round((LCOLS * height) / Math.max(1, width)));
  const lgrid = new Float32Array(LCOLS * LROWS);
  const lcount = new Float32Array(LCOLS * LROWS);

  for (let y = 0, ry = 0; y < height; y += step, ry++) {
    for (let x = 0, rx = 0; x < width; x += step, rx++) {
      const i = (y * width + x) * channels;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const lum = luminance(r, g, b);
      const bg = sampleField(field, cols, rows, x / width, y / height);
      const darker = Math.max(0, bg - lum);   // 背景より暗い分
      const c = chroma(r, g, b);
      // しきい値は「壁紙のムラや床の継ぎ目では立たず、家具では立つ」水準。
      // 実写4枚(木/黒布/ピンク/水色/白天板)で確認して決めた。
      // 二値ではなく重みにする。柔らかい影は「少しだけ暗い」ので寄与が
      // 小さく、家具本体(はっきり暗い/はっきり有彩色)が射影を支配する。
      // 実測: 丸テーブルの加工後は大きな影が画面の大半に広がっており、
      // 二値だと画面全体が被写体と判定されていた。
      // 背景より「明るい」方向のズレも見る。白いテーブルや白い天板は
      // 床より暗くならず彩度も持たないため、暗さと彩度だけでは拾えない。
      // ただし床のスポット光を拾いすぎないよう、重みは控えめにする。
      const brighter = Math.max(0, lum - bg);

      // 輪郭の鋭さ。白い天板を白い床の上で見分ける決め手はこれで、
      // 明るさでも彩度でも区別がつかない(実測で尤度0.04しか立たず、
      // cropが天板を切っていた)。壁のムラや床のスポット光はなだらかで
      // 勾配が立たないのに対し、商品の縁は数画素で大きく変化する。
      let grad = 0;
      if (x >= step && x + step < width && y >= step && y + step < height) {
        const li = (yy: number, xx: number): number => {
          const k = (yy * width + xx) * channels;
          return luminance(data[k], data[k + 1], data[k + 2]);
        };
        grad = Math.max(Math.abs(li(y, x + step) - li(y, x - step)), Math.abs(li(y + step, x) - li(y - step, x)));
      }

      const w =
        Math.min(1, Math.max(0, (darker - 26) / 55)) +
        Math.min(1, Math.max(0, (c - 30) / 55)) +
        0.6 * Math.min(1, Math.max(0, (brighter - 34) / 60)) +
        0.8 * Math.min(1, Math.max(0, (grad - 14) / 45));
      const li = Math.min(LROWS - 1, Math.floor((y / height) * LROWS)) * LCOLS + Math.min(LCOLS - 1, Math.floor((x / width) * LCOLS));
      lgrid[li] += Math.min(1, w);
      lcount[li] += 1;
      if (w > 0) {
        colScore[rx] += w;
        rowScore[ry] += w;
        if (w >= 0.5) subjectPixels++;
      }
      totalPixels++;
    }
  }

  const bboxFrom = (score: Float64Array, size: number): { lo: number; hi: number; peak: number } => {
    let peak = 0;
    for (const v of score) if (v > peak) peak = v;
    if (peak === 0) return { lo: 0, hi: size - 1, peak: 0 };
    // 最外端ではなく「最大の連続run」を採る。最外端だと、画面の隅にある
    // 別の暗い物(壁の角、写り込んだ機材、床の影の端)まで巻き込んで
    // bboxが画面いっぱいに広がる。実測で、水色ソファの加工前が
    // x0-70%(左端は壁の角)になっていたのがこれ。
    // 小さな谷(脚と脚の間など)で切れないよう、短い切れ目は繋ぐ。
    const thr = peak * 0.22;
    const gapTolerance = Math.max(2, Math.round(score.length * 0.04));
    let bestLo = -1, bestHi = -1, bestLen = 0;
    let curLo = -1, gap = 0;
    for (let i = 0; i < score.length; i++) {
      if (score[i] >= thr) {
        if (curLo < 0) curLo = i;
        gap = 0;
      } else if (curLo >= 0) {
        gap++;
        if (gap > gapTolerance) {
          const hiEnd = i - gap;
          if (hiEnd - curLo + 1 > bestLen) { bestLen = hiEnd - curLo + 1; bestLo = curLo; bestHi = hiEnd; }
          curLo = -1; gap = 0;
        }
      }
    }
    if (curLo >= 0) {
      const hiEnd = score.length - 1 - Math.min(gap, score.length - 1);
      if (hiEnd - curLo + 1 > bestLen) { bestLen = hiEnd - curLo + 1; bestLo = curLo; bestHi = hiEnd; }
    }
    if (bestLo < 0) return { lo: 0, hi: size - 1, peak: 0 };

    // ヒステリシス: 高いしきい値で見つけた「核」から、低いしきい値で
    // 外側へ伸ばす。
    //
    // 椅子やテーブルの脚は細く、射影のスコアが本体より一桁小さい。
    // 単一しきい値だと脚が丸ごと落ち、そのbboxでcropすると**脚を切る**。
    // 実測で、椅子の加工前がy29-41%(座面だけ)になり、実際の脚先である
    // y80%付近が欠けていた。核は誤検出しない高さで取り、そこから
    // 地続きに続いている限りは弱い信号も被写体として取り込む。
    const thrLow = peak * 0.05;
    let lo2 = bestLo, hi2 = bestHi;
    while (lo2 > 0 && score[lo2 - 1] >= thrLow) lo2--;
    while (hi2 < score.length - 1 && score[hi2 + 1] >= thrLow) hi2++;
    return { lo: lo2, hi: hi2, peak };
  };

  for (let i = 0; i < lgrid.length; i++) lgrid[i] = lcount[i] > 0 ? lgrid[i] / lcount[i] : 0;
  const likelihood = { grid: lgrid, cols: LCOLS, rows: LROWS };

  const cx = bboxFrom(colScore, colScore.length);
  const cy = bboxFrom(rowScore, rowScore.length);
  if (cx.peak === 0 || cy.peak === 0 || cx.hi <= cx.lo || cy.hi <= cy.lo) {
    return { bbox: null, confidence: 0, occupancy: 0, floorContactY: null, likelihood };
  }

  const x0 = (cx.lo / colScore.length);
  const x1 = ((cx.hi + 1) / colScore.length);
  const y0 = (cy.lo / rowScore.length);
  const y1 = ((cy.hi + 1) / rowScore.length);

  // confidence: 被写体が「小さすぎず・大きすぎず・端に張り付いていない」ほど高い。
  // 画面いっぱいに広がる＝背景を分離できていない疑いなので下げる。
  const areaRatio = (x1 - x0) * (y1 - y0);
  const spread = areaRatio > 0.92 ? 0.15 : areaRatio < 0.005 ? 0.15 : 1;
  const peakRatio = Math.min(cx.peak / rowScore.length, cy.peak / colScore.length);

  // 尤度そのものの強さも確信度に入れる。
  //
  // 射影の形だけを見ていると、「商品がはっきり写っている」場合と
  // 「床のスポット光のような弱い信号が広く分布している」場合を区別できない。
  // 実測では、よく検出できたピンクチェアの尤度ピークが0.74だったのに対し、
  // 丸テーブルは0.17しかなく、それでも確信度0.59が出て自動cropが走り、
  // 床の明かりを商品と見なした結果スタジオ機材まで構図へ入れてしまった。
  // 弱い検出のときは寄せずに元の構図を保つ(§27)。
  // グリッド全体の最大値ではなく、bbox内部の平均を使う。最大値は
  // ボルトや影の縁のような局所的な高コントラストで簡単に上がってしまい、
  // 「広く薄く誤検出している」状態と区別できない。
  let inSum = 0, inCount = 0;
  for (let gy = 0; gy < LROWS; gy++) {
    for (let gx = 0; gx < LCOLS; gx++) {
      const u = (gx + 0.5) / LCOLS;
      const v = (gy + 0.5) / LROWS;
      if (u < x0 || u > x1 || v < y0 || v > y1) continue;
      inSum += lgrid[gy * LCOLS + gx];
      inCount++;
    }
  }
  const meanInside = inCount ? inSum / inCount : 0;
  const strength = Math.min(1, Math.max(0, (meanInside - 0.14) / 0.16));

  const confidence = Math.max(0, Math.min(1, spread * Math.min(1, peakRatio * 3) * strength));

  // 検出したbboxを、隣接する「被写体らしい」領域へ伸ばす。
  //
  // 射影で取れるのは信号の強い本体だけで、白い天板のように背景と
  // 輝度・彩度が近い付属部分は落ちる。実際、ピンクチェアの組では
  // 左隣の白いテーブルが落ち、そのbboxでcropするとテーブルを切った。
  // 尤度マップ上で隣の帯を見て、まだ商品が続いているなら取り込む。
  const grown = growToLikelihood({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, likelihood);

  return {
    bbox: grown,
    confidence,
    occupancy: totalPixels ? subjectPixels / totalPixels : 0,
    floorContactY: grown.y + grown.height,
    likelihood,
  };
}

/** 画像全体の統計。露出補正の判断材料。 */
export function analyzeExposure(img: RawImage): { median: number; p95: number; highlightClipRatio: number; shadowClipRatio: number } {
  const { data, width, height, channels } = img;
  const step = Math.max(1, Math.floor(Math.min(width, height) / 300));
  const lums: number[] = [];
  let hi = 0, lo = 0, n = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * channels;
      const l = luminance(data[i], data[i + 1], data[i + 2]);
      lums.push(l);
      if (l >= 250) hi++;
      if (l <= 4) lo++;
      n++;
    }
  }
  lums.sort((a, b) => a - b);
  return {
    median: percentile(lums, 0.5),
    p95: percentile(lums, 0.95),
    highlightClipRatio: n ? hi / n : 0,
    shadowClipRatio: n ? lo / n : 0,
  };
}

/** 1枚ぶんの解析をまとめて行う。 */
export function analyzeImage(img: RawImage): ImageAnalysis {
  const fieldInfo = estimateBackgroundField(img);
  const background = analyzeBackground(img, fieldInfo);
  const subject = analyzeSubject(img, fieldInfo);
  const exposure = analyzeExposure(img);
  return {
    width: img.width,
    height: img.height,
    background,
    subject,
    overallMedianLuminance: exposure.median,
    highlightClipRatio: exposure.highlightClipRatio,
    shadowClipRatio: exposure.shadowClipRatio,
    overallP95Luminance: exposure.p95,
  };
}

/**
 * 粗い被写体尤度マップから、指定した正規化矩形の周縁(内側の細い帯)の
 * 平均尤度を返す。cropの切り口が商品を横切っていないかの判定に使う。
 */
export function borderLikelihood(
  likelihood: { grid: Float32Array; cols: number; rows: number },
  rect: NormalizedRect,
  bandRatio = 0.035,
): number {
  const { grid, cols, rows } = likelihood;
  const at = (u: number, v: number): number => {
    const gx = Math.min(cols - 1, Math.max(0, Math.floor(u * cols)));
    const gy = Math.min(rows - 1, Math.max(0, Math.floor(v * rows)));
    return grid[gy * cols + gx];
  };
  const bandW = Math.max(1 / cols, rect.width * bandRatio);
  const bandH = Math.max(1 / rows, rect.height * bandRatio);
  const N = 40;
  const top: number[] = [], bottom: number[] = [], left: number[] = [], right: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) / N;
    const u = rect.x + rect.width * t;
    const v = rect.y + rect.height * t;
    top.push(at(u, rect.y + bandH / 2));
    bottom.push(at(u, rect.y + rect.height - bandH / 2));
    left.push(at(rect.x + bandW / 2, v));
    right.push(at(rect.x + rect.width - bandW / 2, v));
  }
  // 4辺の平均をさらに平均してはいけない。
  //
  // 1辺だけが商品を横切っていても、残り3辺が背景(実測0.00)なら全体平均は
  // 薄まって閾値を下回る。実際、ピンクチェアの左辺は0.04あったのに全体
  // 平均では0.01となり、白いテーブルを切る案がそのまま通っていた。
  // 「どこか1辺でも商品に掛かっていたら駄目」なので最大値で判定する。
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.max(mean(top), mean(bottom), mean(left), mean(right));
}

/**
 * bboxの各辺を、隣接する帯の被写体尤度が高い間だけ外側へ伸ばす。
 *
 * 「検出漏れした付属部分(白い天板・淡い色の脚など)を取りこぼさない」
 * ことだけが目的なので、伸ばせる量には上限を設ける。背景のムラで
 * 際限なく広がらないよう、閾値は本体より低めだが0ではない値にする。
 */
export function growToLikelihood(
  bbox: NormalizedRect,
  likelihood: { grid: Float32Array; cols: number; rows: number },
  /**
   * 拡張を続ける下限。
   *
   * このスタジオ背景では壁も床も尤度が実測でちょうど0.00になるため、
   * 0.03でも「何かある」と「無地の背景」を十分に分けられる。
   * 0.12にしていたときは、白いテーブル(実測0.02〜0.14)の外側半分に
   * 届かず、cropが天板を切っていた。maxGrowが暴走を止める。
   */
  threshold = 0.03,
  maxGrow = 0.28,
): NormalizedRect {
  const { grid, cols, rows } = likelihood;
  const stripMean = (x0: number, y0: number, x1: number, y1: number): number => {
    const gx0 = Math.max(0, Math.floor(x0 * cols));
    const gx1 = Math.min(cols, Math.ceil(x1 * cols));
    const gy0 = Math.max(0, Math.floor(y0 * rows));
    const gy1 = Math.min(rows, Math.ceil(y1 * rows));
    let sum = 0, n = 0;
    for (let gy = gy0; gy < gy1; gy++) for (let gx = gx0; gx < gx1; gx++) { sum += grid[gy * cols + gx]; n++; }
    return n ? sum / n : 0;
  };

  let { x, y, width, height } = bbox;
  const stepX = 1 / cols;
  const stepY = 1 / rows;
  // 伸ばせる量は「確信を持って検出できた大きさ」に対する相対値で抑える。
  //
  // 画面比の固定値(0.28)だけで抑えていたときは、丸テーブルの影が右方向へ
  // 伸びているのを伝って、床を挟んだ先にあるスタジオ機材まで取り込み、
  // その機材ごと構図に入ってしまった。仕様§2.4は「右の機材をcropで
  // 除外する」ことを明示している。検出済みの商品の半分を超えて広がる
  // ことは、通常「別の物を巻き込んでいる」ことを意味する。
  const growX = Math.min(maxGrow, width * 0.5);
  const growY = Math.min(maxGrow, height * 0.5);
  const limitL = Math.max(0, x - growX);
  const limitR = Math.min(1, x + width + growX);
  const limitT = Math.max(0, y - growY);
  const limitB = Math.min(1, y + height + growY);

  while (x - stepX >= limitL && stripMean(x - stepX, y, x, y + height) >= threshold) { width += stepX; x -= stepX; }
  while (x + width + stepX <= limitR && stripMean(x + width, y, x + width + stepX, y + height) >= threshold) width += stepX;
  while (y - stepY >= limitT && stripMean(x, y - stepY, x + width, y) >= threshold) { height += stepY; y -= stepY; }
  while (y + height + stepY <= limitB && stripMean(x, y + height, x + width, y + height + stepY) >= threshold) height += stepY;

  return { x, y, width: Math.min(1 - x, width), height: Math.min(1 - y, height) };
}
