"use server";

import { randomUUID } from "node:crypto";
import { saveKnowledgeBody, listRevisions, restoreKnowledgeRevision, type KnowledgeRevisionRecord } from "@/lib/knowledge/revisions";
import { revalidatePath } from "next/cache";
import { getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import {
  deleteKnowledgeDocument,
  listKnowledgeDocuments,
  readKnowledgeContent,
  replaceKnowledgeContent,
  saveKnowledgeDocument,
  updateKnowledgeMetadata,
  type KnowledgeDocumentRecord,
} from "@/lib/knowledge/store";
import { ensureKnowledgeSeed, type KnowledgeSeedResult } from "@/lib/knowledge/seed";
import { getAIReplySettings, updateAIReplySettings, type AIReplySettings } from "@/lib/inquiry/settings";

/**
 * §5/§22/§42 ナレッジ文書管理とAI返信設定のServer Action層。
 *
 * 【権限】管理操作(登録・差し替え・削除・メタデータ編集・ダウンロード)は
 * すべてADMIN限定(§22)。一覧の閲覧もADMIN限定にしている —— 設定画面
 * 自体がADMINにしか出ないため、それ以外の役割がここを呼ぶ経路は無い。
 *
 * 【戻り値の形】このファイルの関数は例外を投げず`{ok:...}`を返す。
 * 理由はapp/actions/ai.tsの冒頭コメントに書かれている通りで、
 * production buildではServer Actionがthrowした例外のmessageがNext.jsに
 * よってマスクされ、利用者に何も伝わらないため。
 */

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
      stack: err instanceof Error ? err.stack : undefined,
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

type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string; correlationId: string };

export async function listKnowledgeDocumentsAction(): Promise<ActionResult<KnowledgeDocumentRecord[]>> {
  const correlationId = randomUUID();
  try {
    await requireAdmin();
    return { ok: true, data: await listKnowledgeDocuments() };
  } catch (err) {
    logActionFailure("listKnowledgeDocumentsAction", correlationId, {}, err);
    return { ok: false, error: safeErrorMessage(err, "ナレッジ文書の取得に失敗しました。"), correlationId };
  }
}

export async function uploadKnowledgeDocumentAction(input: {
  fileName: string;
  mimeType: string;
  content: string;
  title: string;
  description: string | null;
  category: string | null;
}): Promise<ActionResult<KnowledgeDocumentRecord>> {
  const correlationId = randomUUID();
  try {
    const who = await requireAdmin();
    const result = await saveKnowledgeDocument({ ...input, aiReferenceEnabled: true, isActive: true }, who);
    if (!result.ok) return { ok: false, error: result.errors.join(" / "), correlationId };
    revalidatePath("/inventory/settings");
    return { ok: true, data: result.document };
  } catch (err) {
    logActionFailure("uploadKnowledgeDocumentAction", correlationId, { fileName: input.fileName }, err);
    return { ok: false, error: safeErrorMessage(err, "ナレッジ文書の登録に失敗しました。"), correlationId };
  }
}

export async function replaceKnowledgeDocumentAction(
  id: string,
  input: { fileName: string; mimeType: string; content: string },
): Promise<ActionResult<KnowledgeDocumentRecord>> {
  const correlationId = randomUUID();
  try {
    const who = await requireAdmin();
    const result = await replaceKnowledgeContent(id, input, who);
    if (!result.ok) return { ok: false, error: result.errors.join(" / "), correlationId };
    revalidatePath("/inventory/settings");
    return { ok: true, data: result.document };
  } catch (err) {
    logActionFailure("replaceKnowledgeDocumentAction", correlationId, { id, fileName: input.fileName }, err);
    return { ok: false, error: safeErrorMessage(err, "ナレッジ文書の差し替えに失敗しました。"), correlationId };
  }
}

export async function updateKnowledgeMetadataAction(
  id: string,
  patch: { title?: string; description?: string | null; category?: string | null; isActive?: boolean; aiReferenceEnabled?: boolean },
): Promise<ActionResult<KnowledgeDocumentRecord>> {
  const correlationId = randomUUID();
  try {
    const who = await requireAdmin();
    const updated = await updateKnowledgeMetadata(id, patch, who);
    revalidatePath("/inventory/settings");
    return { ok: true, data: updated };
  } catch (err) {
    logActionFailure("updateKnowledgeMetadataAction", correlationId, { id }, err);
    return { ok: false, error: safeErrorMessage(err, "ナレッジ文書の更新に失敗しました。"), correlationId };
  }
}

export async function deleteKnowledgeDocumentAction(id: string): Promise<ActionResult<true>> {
  const correlationId = randomUUID();
  try {
    await requireAdmin();
    await deleteKnowledgeDocument(id);
    revalidatePath("/inventory/settings");
    return { ok: true, data: true };
  } catch (err) {
    logActionFailure("deleteKnowledgeDocumentAction", correlationId, { id }, err);
    return { ok: false, error: safeErrorMessage(err, "ナレッジ文書の削除に失敗しました。"), correlationId };
  }
}

/**
 * §5.3/§5.4 中身の取得(プレビューとダウンロードの両方が使う)。
 *
 * 恒久的な公開URLも署名付きURLもブラウザへ渡さない。中身をこの
 * Server Actionの戻り値として返し、ダウンロードはクライアント側で
 * Blobを組み立てて行う —— 認証を通らないダウンロード経路が存在しない。
 */
export async function readKnowledgeContentAction(id: string): Promise<ActionResult<{ fileName: string; mimeType: string; content: string }>> {
  const correlationId = randomUUID();
  try {
    await requireAdmin();
    const content = await readKnowledgeContent(id);
    if (!content) return { ok: false, error: "対象のナレッジ文書が見つかりません。", correlationId };
    return { ok: true, data: content };
  } catch (err) {
    logActionFailure("readKnowledgeContentAction", correlationId, { id }, err);
    return { ok: false, error: safeErrorMessage(err, "ナレッジ文書の取得に失敗しました。"), correlationId };
  }
}

/** §6/§7 初期文書の登録。既に同じタイトルがあれば何もしない。 */
export async function seedKnowledgeDocumentsAction(): Promise<ActionResult<KnowledgeSeedResult>> {
  const correlationId = randomUUID();
  try {
    const who = await requireAdmin();
    return { ok: true, data: await ensureKnowledgeSeed(who) };
  } catch (err) {
    logActionFailure("seedKnowledgeDocumentsAction", correlationId, {}, err);
    return { ok: false, error: safeErrorMessage(err, "初期ナレッジの登録に失敗しました。"), correlationId };
  }
}

export async function getAIReplySettingsAction(): Promise<ActionResult<AIReplySettings>> {
  const correlationId = randomUUID();
  try {
    await requireAdmin();
    return { ok: true, data: await getAIReplySettings() };
  } catch (err) {
    logActionFailure("getAIReplySettingsAction", correlationId, {}, err);
    return { ok: false, error: safeErrorMessage(err, "AI返信設定の取得に失敗しました。"), correlationId };
  }
}

/**
 * §41 自動送信フラグはここから変更できない。
 *
 * 引数の型にそもそも含めていないのは、UI側の実装ミスやコピー&ペーストで
 * 誤って有効化される経路を型で塞ぐため。将来自動送信を実装するときは、
 * 専用の(より強い確認を伴う)操作として別に作る。
 */
export async function updateAIReplySettingsAction(patch: {
  autoDraftEnabled?: boolean;
  webResearchEnabled?: boolean;
  knowledgeEnabled?: boolean;
}): Promise<ActionResult<AIReplySettings>> {
  const correlationId = randomUUID();
  try {
    const who = await requireAdmin();
    const updated = await updateAIReplySettings(patch, who);
    revalidatePath("/inventory/settings");
    return { ok: true, data: updated };
  } catch (err) {
    logActionFailure("updateAIReplySettingsAction", correlationId, {}, err);
    return { ok: false, error: safeErrorMessage(err, "AI返信設定の保存に失敗しました。"), correlationId };
  }
}

/**
 * ナレッジ文書の本文をその場で編集して保存する(ADMIN限定)。
 *
 * 競合検知のため、編集を始めた時点の version を必ず渡してもらう。
 * 古い画面からの上書きで、他の人の変更を消さないようにするため。
 */
export async function saveKnowledgeBodyAction(input: {
  documentId: string;
  body: string;
  expectedVersion: number;
}): Promise<ActionResult<KnowledgeDocumentRecord>> {
  const correlationId = randomUUID();
  try {
    const who = await requireAdmin();
    const result = await saveKnowledgeBody({
      documentId: String(input?.documentId ?? ""),
      body: typeof input?.body === "string" ? input.body : "",
      expectedVersion: Number(input?.expectedVersion),
      who,
    });
    if (!result.ok) return { ok: false, error: result.message, correlationId };
    revalidatePath("/inventory/settings");
    return { ok: true, data: result.document };
  } catch (err) {
    logActionFailure("saveKnowledgeBodyAction", correlationId, { documentId: input?.documentId }, err);
    return { ok: false, error: safeErrorMessage(err, "保存に失敗しました。"), correlationId };
  }
}

/** 履歴一覧(旧版のみ。現在版は KnowledgeDocument 側)。 */
export async function listKnowledgeRevisionsAction(documentId: string): Promise<ActionResult<KnowledgeRevisionRecord[]>> {
  const correlationId = randomUUID();
  try {
    await requireAdmin();
    return { ok: true, data: await listRevisions(documentId) };
  } catch (err) {
    logActionFailure("listKnowledgeRevisionsAction", correlationId, { documentId }, err);
    return { ok: false, error: safeErrorMessage(err, "履歴の取得に失敗しました。"), correlationId };
  }
}

/**
 * 指定した版へ戻す。
 *
 * 「いきなり上書きしない」という要件は、**画面側が対象版の中身を見せて
 * 確認を取ってから**このactionを呼ぶことで満たす。
 */
export async function restoreKnowledgeRevisionAction(input: {
  documentId: string;
  revisionId: string;
  expectedVersion: number;
}): Promise<ActionResult<KnowledgeDocumentRecord>> {
  const correlationId = randomUUID();
  try {
    const who = await requireAdmin();
    const result = await restoreKnowledgeRevision({
      documentId: String(input?.documentId ?? ""),
      revisionId: String(input?.revisionId ?? ""),
      expectedVersion: Number(input?.expectedVersion),
      who,
    });
    if (!result.ok) return { ok: false, error: result.message, correlationId };
    revalidatePath("/inventory/settings");
    return { ok: true, data: result.document };
  } catch (err) {
    logActionFailure("restoreKnowledgeRevisionAction", correlationId, { documentId: input?.documentId }, err);
    return { ok: false, error: safeErrorMessage(err, "復元に失敗しました。"), correlationId };
  }
}
