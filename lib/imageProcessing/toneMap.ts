import type { ImageAnalysis } from "./analysis";

/**
 * BELLO画像自動加工 — 露出・周辺減光・ホワイトバランス(2026-08-31 仕様書 §9〜§14)。
 *
 * ## 従来の状態
 *
 * `sharpProcessor.ts`のトーン補正は`DEFAULT_ADJUSTMENTS`(恒等変換)を既定と
 * しており、workerは`adjustments: {}`しか渡していなかった。つまり
 * **明るさもWBも彩度も一切変わっていなかった**。提示されたBeforeは
 * 実測で背景輝度51〜166・周辺減光52〜109・青チャンネルが突出(紫かぶり)
 * という状態で、そこへ何もしなければAfterには決して近づかない。
 *
 * ## 方針(仕様の禁止事項をそのまま制約にする)
 *
 * - 背景を「RGB255の白」にしない。理想写真の壁は白〜薄灰で、質感が残る。
 * - 商品の色を理想写真の色へ寄せない。WB補正には上限を設ける。
 * - 影を消さない。暗部の持ち上げは弱く、下限を切らない。
 * - 白飛び・黒潰れを作らない。ハイライト側は圧縮して守る。
 * - HDR的な不自然さを出さない。局所コントラストを持ち上げない。
 *
 * ここは「どういう補正をかけるか」を決めるだけで、ピクセル操作は
 * `sharpProcessor.ts`が行う。決定は数値として記録され、あとから
 * 「なぜこう加工されたのか」を説明できる(§41 observability)。
 */

export interface ToneTargets {
  /**
   * 背景(壁・床)の目標輝度。理想写真4枚の実測は185〜214だった。
   * 255(純白)にはしない — 壁のテクスチャと壁床の境界を残すため。
   */
  backgroundLuminance: number;
  /** 背景輝度の許容下限。これを下回るなら持ち上げる。 */
  backgroundLuminanceMin: number;
  /** 露出補正の上限(EV)。これ以上は上げない(暗すぎる写真を無理に救わない)。 */
  maxExposureEv: number;
  /** ホワイトバランス補正の上限。チャンネル倍率の1.0からの最大乖離。 */
  maxWhiteBalanceShift: number;
  /** 周辺減光の補正率(0..1)。1.0で完全フラット化。理想写真は完全には平らでない。 */
  vignetteCorrection: number;
  /** 白飛びとみなす画素割合の許容上限。超えるなら露出を控える。 */
  maxHighlightClipRatio: number;
}

export const DEFAULT_TONE_TARGETS: ToneTargets = {
  backgroundLuminance: 198,
  backgroundLuminanceMin: 170,
  maxExposureEv: 1.6,
  maxWhiteBalanceShift: 0.12,
  vignetteCorrection: 0.85,
  maxHighlightClipRatio: 0.02,
};

export interface TonePlan {
  /** 全体のゲイン。1.0で無補正。露出補正をチャンネル共通の倍率として持つ。 */
  gain: number;
  /** R/Bチャンネルの相対倍率。色かぶりの補正。Gは常に1.0を基準にする。 */
  gainR: number;
  gainB: number;
  /**
   * ハイライトのロールオフ開始点(0..255)。ここから上を圧縮して白飛びを防ぐ。
   * ゲインをかけると壁の明るい部分が255へ張り付くため、必ず併用する。
   */
  highlightKnee: number;
  /** 周辺減光の補正量(中心に対する隅の持ち上げ幅、0..255相当)。 */
  vignetteLift: number;
  /** 判断の根拠。UI/ログ用。 */
  notes: string[];
}

/** 補正なしを表すプラン。 */
export const IDENTITY_TONE_PLAN: TonePlan = {
  gain: 1,
  gainR: 1,
  gainB: 1,
  highlightKnee: 255,
  vignetteLift: 0,
  notes: [],
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * 解析結果から補正量を決める。
 *
 * 背景の輝度を目標へ寄せることを基準にする。「画像全体の平均を明るくする」
 * のではない — 黒い張地や濃い木部が大きく写っているほど平均は下がるので、
 * 平均を基準にすると商品によって仕上がりがばらつく(仕様§9)。背景は
 * どの商品でも同じスタジオの壁と床なので、揃える基準として正しい。
 */
export function planTone(analysis: ImageAnalysis, targets: ToneTargets = DEFAULT_TONE_TARGETS): TonePlan {
  const notes: string[] = [];
  const bg = analysis.background;

  // 1) 露出: 背景輝度を目標へ。
  let gain = 1;
  if (bg.medianLuminance > 4 && bg.medianLuminance < targets.backgroundLuminanceMin) {
    gain = targets.backgroundLuminance / bg.medianLuminance;
    const maxGain = Math.pow(2, targets.maxExposureEv);
    if (gain > maxGain) {
      gain = maxGain;
      notes.push(`露出は上限${targets.maxExposureEv}EVで頭打ち(元の背景が暗すぎるため無理に持ち上げない)`);
    }
    notes.push(`背景輝度 ${bg.medianLuminance.toFixed(0)} → 目標 ${targets.backgroundLuminance} のためゲイン ${gain.toFixed(2)}`);
  } else {
    notes.push(`背景輝度 ${bg.medianLuminance.toFixed(0)} は既に十分明るいので露出は変えない`);
  }

  // 2) ハイライトの余地でゲインを頭打ちにする。
  //
  // 背景輝度だけを見てゲインを決めると、極端に暗い写真で倍率が跳ね上がる。
  // 実測では、背景輝度51の写真がゲイン3.03になり、出力の背景が254、
  // 白飛び率62%まで飛んだ。明るい側の95パーセンタイルが245を超えない
  // 範囲に抑えれば、階調を潰さずに持ち上げられる分だけを使うことになる。
  // 「暗い写真を無理に救わない」という方針の実装でもある。
  const p95 = analysis.overallP95Luminance;
  if (p95 > 8) {
    const headroomGain = 245 / p95;
    if (gain > headroomGain) {
      notes.push(`明るい側(95%点 ${p95.toFixed(0)})を飛ばさないため、ゲインを ${gain.toFixed(2)} → ${Math.max(1, headroomGain).toFixed(2)} へ制限`);
      gain = Math.max(1, headroomGain);
    }
  }

  // 3) 既に白飛びが多い画像は、これ以上持ち上げない。
  if (analysis.highlightClipRatio > targets.maxHighlightClipRatio && gain > 1) {
    const reduced = 1 + (gain - 1) * 0.4;
    notes.push(`白飛びが${(analysis.highlightClipRatio * 100).toFixed(1)}%あるためゲインを${gain.toFixed(2)}→${reduced.toFixed(2)}へ抑制`);
    gain = reduced;
  }

  // 3) ホワイトバランス: 背景は本来ニュートラルなはずなので、そのズレを取る。
  //    ただし補正量に上限を設ける — 上限が無いと、色付きの壁や商品の照り返しを
  //    「かぶり」と誤認して商品の色まで動かしてしまう(仕様§10の禁止事項)。
  let gainR = 1;
  let gainB = 1;
  const g = bg.meanG;
  if (g > 8) {
    const rawR = g / Math.max(1, bg.meanR);
    const rawB = g / Math.max(1, bg.meanB);
    gainR = clamp(rawR, 1 - targets.maxWhiteBalanceShift, 1 + targets.maxWhiteBalanceShift);
    gainB = clamp(rawB, 1 - targets.maxWhiteBalanceShift, 1 + targets.maxWhiteBalanceShift);
    const capped = Math.abs(rawR - gainR) > 0.001 || Math.abs(rawB - gainB) > 0.001;
    notes.push(
      `背景RGB ${bg.meanR.toFixed(0)}/${bg.meanG.toFixed(0)}/${bg.meanB.toFixed(0)} からWB補正 R×${gainR.toFixed(3)} B×${gainB.toFixed(3)}` +
        (capped ? "(上限で頭打ち — 商品色を動かさないため)" : ""),
    );
  }

  // 4) 周辺減光: 隅が暗いぶんを持ち上げる。完全にフラットにはしない。
  const vignetteLift = bg.vignetteDrop > 12 ? bg.vignetteDrop * targets.vignetteCorrection : 0;
  if (vignetteLift > 0) {
    notes.push(`周辺減光 ${bg.vignetteDrop.toFixed(0)} を ${(targets.vignetteCorrection * 100).toFixed(0)}% 補正`);
  }

  // 5) ハイライト保護: ゲイン後に255へ張り付く領域を作らないよう、
  //    ゲインに応じてロールオフ開始点を下げる。
  const highlightKnee = gain > 1.02 ? clamp(235 / gain, 140, 250) : 255;

  return { gain, gainR, gainB, highlightKnee, vignetteLift, notes };
}

/**
 * トーンカーブを256段のルックアップテーブルとして構築する。
 *
 * ゲインをそのまま乗じると明るい側が飽和して壁のテクスチャが消えるため、
 * `knee`から上はなだらかに255へ収束させる(ソフトなロールオフ)。
 * 暗部側は触らない — 影はBELLO写真の立体感の一部で、持ち上げると
 * 平面的になる(仕様§12)。
 */
export function buildToneCurve(gain: number, knee: number): Uint8Array {
  const lut = new Uint8Array(256);
  const kneeOut = knee * gain;
  for (let i = 0; i < 256; i++) {
    let out: number;
    if (i <= knee) {
      out = i * gain;
    } else {
      // knee..255 を kneeOut..255 へ、傾きが徐々に0へ落ちる曲線で写す。
      const t = (i - knee) / Math.max(1, 255 - knee);
      const headroom = 255 - Math.min(254, kneeOut);
      out = Math.min(254, kneeOut) + headroom * (1 - Math.pow(1 - t, 2));
    }
    lut[i] = clamp(Math.round(out), 0, 255);
  }
  return lut;
}
