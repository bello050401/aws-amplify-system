"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import {
  createReplyRule,
  listReplyRulesForAdmin,
  setReplyRuleEnabled,
  softDeleteReplyRule,
  updateReplyRule,
  type ReplyRuleInput,
} from "@/lib/inquiry/replyRuleStore";
import { REPLY_RULE_CATEGORIES, type ReplyRuleRecord } from "@/lib/inquiry/replyRuleSelection";

/**
 * 2026-09-03 指示書 §16/§26: 返信ルールCRUDのServer Action層。
 *
 * 【権限】編集はADMIN限定。返信の判断基準そのものなので、誤編集の影響が
 * 直接顧客への返答に出る。閲覧はEDITORにも許す(運用担当が「なぜこの
 * 返信になったか」を確認できる必要があるため)。
 *
 * 【戻り値の形】例外を投げず {ok:...} を返す。production build では
 * Server Action が throw した例外の message が Next.js にマスクされ、
 * 利用者に何も伝わらないため(app/actions/knowledge.ts と同じ理由)。
 */

type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string; correlationId: string };

function logActionFailure(action: string, correlationId: string, context: Record<string, unknown>, err: unknown): void {
  console.error(
    JSON.stringify({
      level: "error",
      action,
      correlationId,
      timestamp: new Date().toISOString(),
      context,
      errorName: err instanceof Error ? err.name : typeof err,
      errorMessage: err instanceof Error ? err.message : String(err),
    }),
  );
}

function safeErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

async function requireAdmin(): Promise<string | null> {
  const role = await getInventoryRole();
  if (role !== "ADMIN") throw new Error("この操作にはADMIN権限が必要です。");
  return getCurrentInventoryUserEmail();
}

async function requireViewer(): Promise<void> {
  const role = await getInventoryRole();
  if (!role) throw new Error("この操作にはログインが必要です。");
}

/**
 * 入力の検証。**保存前にここで弾く。**
 *
 * instruction が空のルールは、AIへ渡っても何も効かないうえ、一覧では
 * 「ルールがある」ように見える —— 一番たちの悪い状態なので作らせない。
 */
function validate(input: ReplyRuleInput): string[] {
  const errors: string[] = [];
  if (!input.title.trim()) errors.push("ルール名を入力してください。");
  if (input.title.length > 120) errors.push("ルール名は120文字以内で入力してください。");
  if (!input.instruction.trim()) errors.push("指示内容を入力してください。");
  if (input.instruction.length > 4000) errors.push("指示内容は4,000文字以内で入力してください。");
  if ((input.conditions ?? "").length > 1000) errors.push("適用条件は1,000文字以内で入力してください。");
  if (!REPLY_RULE_CATEGORIES.includes(input.category)) errors.push("分類の指定が不正です。");
  if (!Number.isFinite(input.priority) || input.priority < 0 || input.priority > 9999) {
    errors.push("優先度は0〜9999の数値で入力してください。");
  }
  return errors;
}

export async function listReplyRulesAction(): Promise<ActionResult<ReplyRuleRecord[]>> {
  const correlationId = randomUUID();
  try {
    await requireViewer();
    return { ok: true, data: await listReplyRulesForAdmin() };
  } catch (err) {
    logActionFailure("listReplyRulesAction", correlationId, {}, err);
    return { ok: false, error: safeErrorMessage(err, "返信ルールの取得に失敗しました。"), correlationId };
  }
}

export async function createReplyRuleAction(input: ReplyRuleInput): Promise<ActionResult<ReplyRuleRecord>> {
  const correlationId = randomUUID();
  try {
    const who = await requireAdmin();
    const errors = validate(input);
    if (errors.length > 0) return { ok: false, error: errors.join(" / "), correlationId };
    const created = await createReplyRule(input, who);
    revalidatePath("/inventory/messages");
    return { ok: true, data: created };
  } catch (err) {
    logActionFailure("createReplyRuleAction", correlationId, { title: input.title }, err);
    return { ok: false, error: safeErrorMessage(err, "返信ルールの作成に失敗しました。"), correlationId };
  }
}

export async function updateReplyRuleAction(id: string, input: ReplyRuleInput): Promise<ActionResult<ReplyRuleRecord>> {
  const correlationId = randomUUID();
  try {
    const who = await requireAdmin();
    const errors = validate(input);
    if (errors.length > 0) return { ok: false, error: errors.join(" / "), correlationId };
    const updated = await updateReplyRule(id, input, who);
    revalidatePath("/inventory/messages");
    return { ok: true, data: updated };
  } catch (err) {
    logActionFailure("updateReplyRuleAction", correlationId, { id }, err);
    return { ok: false, error: safeErrorMessage(err, "返信ルールの更新に失敗しました。"), correlationId };
  }
}

export async function setReplyRuleEnabledAction(id: string, enabled: boolean): Promise<ActionResult<null>> {
  const correlationId = randomUUID();
  try {
    const who = await requireAdmin();
    await setReplyRuleEnabled(id, enabled, who);
    revalidatePath("/inventory/messages");
    return { ok: true, data: null };
  } catch (err) {
    logActionFailure("setReplyRuleEnabledAction", correlationId, { id, enabled }, err);
    return { ok: false, error: safeErrorMessage(err, "有効/無効の切り替えに失敗しました。"), correlationId };
  }
}

/** §26 削除はソフトデリート。過去のAI処理ログから根拠を消さない。 */
export async function deleteReplyRuleAction(id: string): Promise<ActionResult<null>> {
  const correlationId = randomUUID();
  try {
    const who = await requireAdmin();
    await softDeleteReplyRule(id, who);
    revalidatePath("/inventory/messages");
    return { ok: true, data: null };
  } catch (err) {
    logActionFailure("deleteReplyRuleAction", correlationId, { id }, err);
    return { ok: false, error: safeErrorMessage(err, "返信ルールの削除に失敗しました。"), correlationId };
  }
}
