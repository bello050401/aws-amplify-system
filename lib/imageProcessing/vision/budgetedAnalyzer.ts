import type { VisionAnalysisInput, VisionAnalysisResult, VisionAnalyzer } from "./types";

/**
 * Vision呼び出しに上限を設ける（2026-08-31 AI Vision統合仕様書 §35 コスト / §36 障害耐性）。
 *
 * ## なぜ必要か
 *
 * image-processing-workerは1回の起動で最大20件のジョブを処理し、Lambdaの
 * timeoutは300秒である。Vision解析は1件あたり最大20秒×2回試行=40秒かかり得るので、
 * 難例が続いた場合は 20件×40秒 = 800秒 となり、**Lambdaごとtimeoutして
 * 加工結果が1件も保存されない**。AIを足したせいで従来動いていた処理が
 * 壊れる、という最悪の形になる。
 *
 * そこで「1回の起動で使ってよいAIの回数と時間」を先に決め、使い切ったら
 * 以降は静かにローカル解析へ戻る。予算切れは障害ではないので、例外にせず
 * `null` を返す — 呼び出し側から見れば「AIの助けが得られなかった」だけで、
 * 加工そのものは従来どおり完了する。
 *
 * 同じ理由で、コストの上限にもなる。1枚あたり約1,200入力トークンなので、
 * 予算を決めておかないと大量取り込み時に想定外の請求になり得る。
 */

export interface VisionBudgetOptions {
  /** この解析器で許す最大呼び出し回数。 */
  maxCalls?: number;
  /** 累積で使ってよい時間(ms)。超えたら以降は呼ばない。 */
  maxTotalMs?: number;
}

/** 既定値: Lambda timeout 300秒に対して、AIへ使うのは最大3件・90秒まで。 */
export const DEFAULT_VISION_BUDGET: Required<VisionBudgetOptions> = {
  maxCalls: 3,
  maxTotalMs: 90_000,
};

export interface VisionBudgetState {
  calls: number;
  elapsedMs: number;
  exhausted: boolean;
}

/**
 * 既存のVisionAnalyzerを包んで予算を課す。
 *
 * 中身のモデルには関知しない（§13 モデル交換容易性）。`BedrockVisionAnalyzer`
 * でもモックでも同じように包める。
 */
export class BudgetedVisionAnalyzer implements VisionAnalyzer {
  readonly id: string;
  private readonly inner: VisionAnalyzer;
  private readonly budget: Required<VisionBudgetOptions>;
  private calls = 0;
  private elapsedMs = 0;

  constructor(inner: VisionAnalyzer, options: VisionBudgetOptions = {}) {
    this.inner = inner;
    this.budget = { ...DEFAULT_VISION_BUDGET, ...options };
    this.id = `budgeted(${inner.id})`;
  }

  get state(): VisionBudgetState {
    return { calls: this.calls, elapsedMs: this.elapsedMs, exhausted: this.isExhausted() };
  }

  private isExhausted(): boolean {
    return this.calls >= this.budget.maxCalls || this.elapsedMs >= this.budget.maxTotalMs;
  }

  async analyze(input: VisionAnalysisInput): Promise<VisionAnalysisResult | null> {
    if (this.isExhausted()) {
      // 予算切れ。これは障害ではないのでログは1回だけ、静かにローカルへ戻す。
      if (this.calls === this.budget.maxCalls) {
        console.info(
          `[BudgetedVisionAnalyzer] budget spent (${this.calls} calls / ${Math.round(this.elapsedMs)}ms); continuing without AI`,
        );
        this.calls++; // このログを二度出さないための番兵
      }
      return null;
    }

    this.calls++;
    const startedAt = Date.now();
    try {
      return await this.inner.analyze(input);
    } finally {
      // 失敗した呼び出しも時間は消費している。必ず計上する。
      this.elapsedMs += Date.now() - startedAt;
    }
  }
}
