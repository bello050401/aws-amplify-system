import type { AIGatewayProvider, AIGeneratePolicy, AIGenerateResult, AITask, AITokenUsage, AIToolSchema } from "./types";
import { checkTextQuality, checkStructuredQuality, type TextQualityRules, type QualityGateResult } from "./qualityGate";

/**
 * §4/§4.1: AIRouter — 品質ゲート不合格の場合だけPREMIUMへescalationする。
 * 「無条件二重生成は禁止」(§5)を守るため、ECONOMY/STANDARDの結果が
 * 品質ゲートを通れば、それ以上何もしない(PREMIUMへは絶対に進まない)。
 * 純粋なオーケストレーションのみ — 実際の生成はprovider(Anthropic等)、
 * 判定はqualityGate.tsの純粋関数に委譲する。
 */

/**
 * §6/§15補正(費用記録漏れ修正): 「最終結果1件だけをAIUsageLogへ渡す」
 * 設計だと、品質ゲート不合格でescalationした場合にECONOMY/STANDARD側の
 * 既知usage(実際に課金される)が失われ、escalation呼出自体が例外に
 * なった場合は初回成功分の記録すら残らなかった。
 *
 * 対策として、provider実呼出が完了する度(成功/失敗どちらも、初回・
 * escalation双方)に呼び出し元(gateway.ts)へ通知する。routerはあくまで
 * 「何回・どの結果/エラーで呼ばれたか」を伝えるだけで、記録の実装
 * (永続化先/失敗時の扱い)には関与しない(冒頭コメントの「純粋な
 * オーケストレーションのみ」を維持するため)。
 *
 * これらのフックが例外を投げても(例: ログ書き込み失敗)、escalation
 * 判定や戻り値・スロー内容には一切影響させない — 記録障害を理由に
 * モデルを再呼出したり、生成結果/元のエラーを失ったりしてはならない
 * (§157相当)。
 *
 * 【レビュー補正: 記録タイミング】onAttemptへ渡す`result`は、
 * providerの生の戻り値ではなく、必ずこのファイルのcheckTextQuality/
 * checkStructuredQuality判定を適用し終えた後の値にする — provider
 * 自身は品質ゲートを知らず`qualityGatePassed: true`固定で返すため
 * (anthropicProvider.ts等参照)、判定前の生の結果をそのまま通知すると
 * 実際は不合格だった試行がAIUsageLogへ「合格」として記録されてしまう。
 */
export type RouterAttemptHook<T> = (attempt: { result: AIGenerateResult<T>; escalated: boolean }) => void | Promise<void>;
export type RouterFailureHook = (failure: { error: unknown; escalated: boolean }) => void | Promise<void>;

async function notifyAttempt<T>(onAttempt: RouterAttemptHook<T> | undefined, result: AIGenerateResult<T>, escalated: boolean): Promise<void> {
  if (!onAttempt) return;
  try {
    await onAttempt({ result, escalated });
  } catch (err) {
    // §157相当: 元の例外(errは呼び出し元フック内部の例外)にプロンプト等の
    // 生成内容が偶発的に含まれ得るため、ここでは固定メッセージ+型名だけを
    // 出す(err本体・err.message・err.stackはログへ出さない)。
    console.error(`[router] onAttempt hook failed (non-fatal, generation is unaffected): ${err instanceof Error ? err.constructor.name : typeof err}`);
  }
}

async function notifyFailure(onFailure: RouterFailureHook | undefined, error: unknown, escalated: boolean): Promise<void> {
  if (!onFailure) return;
  try {
    await onFailure({ error, escalated });
  } catch (err) {
    console.error(`[router] onFailure hook failed (non-fatal, original error is still thrown): ${err instanceof Error ? err.constructor.name : typeof err}`);
  }
}

export interface RouterTextRequest {
  task: AITask;
  systemPrompt: string;
  userPrompt: string;
  policy: Omit<AIGeneratePolicy, "tier"> & { initialTier: Exclude<AIGeneratePolicy["tier"], "PREMIUM"> | "PREMIUM" };
  qualityRules?: TextQualityRules;
  /** 品質ゲート判定済みのprovider呼出ごと(初回・escalation双方)に通知する。詳細は{@link RouterAttemptHook}。 */
  onAttempt?: RouterAttemptHook<string>;
  /** provider呼出が例外を投げた時点(初回・escalation双方)に通知する。呼出後、元の例外はそのままthrowされる。 */
  onFailure?: RouterFailureHook;
}

/**
 * §4.1: initialTierで生成→品質ゲート判定→不合格ならPREMIUMで1回だけ
 * 再生成(既にPREMIUMを指定していた場合はescalationしようがないので
 * そのまま返す)。
 */
export async function routeGenerateText(provider: AIGatewayProvider, req: RouterTextRequest): Promise<AIGenerateResult<string>> {
  let first: AIGenerateResult<string>;
  try {
    first = await provider.generateText(req.task, req.systemPrompt, req.userPrompt, { ...req.policy, tier: req.policy.initialTier });
  } catch (err) {
    await notifyFailure(req.onFailure, err, false);
    throw err;
  }
  // 品質ゲート判定を先に確定させてから通知する(判定前の生の結果を
  // 記録に流用しない — 冒頭コメント参照)。
  const gate = checkTextQuality(first.output, req.qualityRules);
  const firstGated: AIGenerateResult<string> = { ...first, qualityGatePassed: gate.pass, qualityGateViolations: gate.violations };
  await notifyAttempt(req.onAttempt, firstGated, false);

  if (gate.pass || req.policy.initialTier === "PREMIUM") {
    return firstGated;
  }

  // §4.1 escalation: 1回だけPREMIUMへ。ここで例外が飛んでも、直前の
  // notifyAttempt(firstGated, false)は既に完了しているため、初回成功分の
  // 記録は失われない(このtry/catchはescalation呼出自体の失敗だけを
  // 個別に通知する)。
  let escalated: AIGenerateResult<string>;
  try {
    escalated = await provider.generateText(req.task, req.systemPrompt, req.userPrompt, { ...req.policy, tier: "PREMIUM" });
  } catch (err) {
    await notifyFailure(req.onFailure, err, true);
    throw err;
  }
  const escalatedGate = checkTextQuality(escalated.output, req.qualityRules);
  const escalatedGated: AIGenerateResult<string> = { ...escalated, fallbackOccurred: true, qualityGatePassed: escalatedGate.pass, qualityGateViolations: escalatedGate.violations };
  await notifyAttempt(req.onAttempt, escalatedGated, true);
  return escalatedGated;
}

export interface RouterStructuredRequest<T extends Record<string, unknown>> {
  task: AITask;
  systemPrompt: string;
  userPrompt: string;
  toolSchema: AIToolSchema;
  policy: Omit<AIGeneratePolicy, "tier"> & { initialTier: AIGeneratePolicy["tier"] };
  requiredNonEmptyFields: (keyof T)[];
  /** 品質ゲート判定済みのprovider呼出ごと(初回・escalation双方)に通知する。詳細は{@link RouterAttemptHook}。 */
  onAttempt?: RouterAttemptHook<T>;
  /** provider呼出が例外を投げた時点(初回・escalation双方)に通知する。呼出後、元の例外はそのままthrowされる。 */
  onFailure?: RouterFailureHook;
}

export async function routeGenerateStructured<T extends Record<string, unknown>>(
  provider: AIGatewayProvider,
  req: RouterStructuredRequest<T>,
): Promise<AIGenerateResult<T>> {
  let first: AIGenerateResult<T>;
  try {
    first = await provider.generateStructured<T>(req.task, req.systemPrompt, req.userPrompt, req.toolSchema, { ...req.policy, tier: req.policy.initialTier });
  } catch (err) {
    await notifyFailure(req.onFailure, err, false);
    throw err;
  }
  const gate = checkStructuredQuality(first.output, req.requiredNonEmptyFields);
  const firstGated: AIGenerateResult<T> = { ...first, qualityGatePassed: gate.pass, qualityGateViolations: gate.violations };
  await notifyAttempt(req.onAttempt, firstGated, false);

  if (gate.pass || req.policy.initialTier === "PREMIUM") {
    return firstGated;
  }

  let escalated: AIGenerateResult<T>;
  try {
    escalated = await provider.generateStructured<T>(req.task, req.systemPrompt, req.userPrompt, req.toolSchema, { ...req.policy, tier: "PREMIUM" });
  } catch (err) {
    await notifyFailure(req.onFailure, err, true);
    throw err;
  }
  const escalatedGate = checkStructuredQuality(escalated.output, req.requiredNonEmptyFields);
  const escalatedGated: AIGenerateResult<T> = { ...escalated, fallbackOccurred: true, qualityGatePassed: escalatedGate.pass, qualityGateViolations: escalatedGate.violations };
  await notifyAttempt(req.onAttempt, escalatedGated, true);
  return escalatedGated;
}

export type { QualityGateResult, AITokenUsage };
