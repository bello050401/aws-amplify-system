import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { getKnowledgeDocument, readKnowledgeContent, replaceKnowledgeContent, type KnowledgeDocumentRecord } from "./store";

/**
 * ナレッジ文書の版管理。誤編集から戻せるようにするためのもの。
 *
 * ## 何を「版」として残すのか
 *
 * 正本はあくまで KnowledgeDocument。ここに積むのは **保存する直前の中身**
 * で、つまり常に「1つ前の状態」である。AIはこの表を一切参照しない
 * (参照するのは KnowledgeDocument.searchText のみ)ので、履歴が
 * AI返信の根拠に混ざる余地がない。
 *
 * ## なぜ2世代なのか
 *
 * 要件が「現在版＋直近2世代」。無制限に貯めると、消したはずの記述が
 * ずっと残り続けることになる —— 社内文書には顧客名や取引条件が入り得る
 * ので、保持期間を決めずに増やすのは避けたい。古いものは保存のたびに
 * 落とす。
 *
 * ## 復元も「新しい変更」として扱う
 *
 * 「1つ前に戻す」は、その版の中身で**新しく保存し直す**操作にする。
 * 履歴を巻き戻して枝を切ると、戻した後にもう一度戻したくなったときに
 * 辿れなくなる。復元後も履歴は前へ進むだけなので壊れない。
 */

/** 現在版に加えて保持する旧版の数。 */
export const MAX_REVISIONS = 2;

export interface KnowledgeRevisionRecord {
  id: string;
  documentId: string;
  version: number;
  title: string | null;
  body: string | null;
  changeType: "MANUAL_EDIT" | "RESTORE" | string;
  restoredFromVersion: number | null;
  changedBy: string | null;
  changedAt: string;
}

function toRevision(row: Record<string, unknown>): KnowledgeRevisionRecord {
  return {
    id: String(row.id),
    documentId: String(row.documentId),
    version: Number(row.version ?? 0),
    title: (row.title as string | null) ?? null,
    body: (row.body as string | null) ?? null,
    changeType: String(row.changeType ?? "MANUAL_EDIT"),
    restoredFromVersion: row.restoredFromVersion === null || row.restoredFromVersion === undefined ? null : Number(row.restoredFromVersion),
    changedBy: (row.changedBy as string | null) ?? null,
    changedAt: String(row.changedAt ?? ""),
  };
}

/** 新しい順。画面は「1つ前」「2つ前」としてこの順に見せる。 */
export async function listRevisions(documentId: string): Promise<KnowledgeRevisionRecord[]> {
  const { data, errors } = await serverDataClient.models.KnowledgeDocumentRevision.listKnowledgeDocumentRevisionByDocumentId(
    { documentId },
    { ...inventoryAuthMode, limit: 50 },
  );
  if (errors) throw new Error(`履歴の取得に失敗しました: ${errors.map((e) => e.message).join("; ")}`);
  return data.map((d) => toRevision(d as unknown as Record<string, unknown>)).sort((a, b) => b.version - a.version);
}

/**
 * どの版を落とすか。純粋関数にしてあるのは、「2世代残す」という規則が
 * 実際に守られていることを、AWSに触らずに固定できるようにするため
 * (scripts/verify-knowledge.ts)。
 *
 * 入力の並び順に依存しないよう、ここで version の降順に並べ直してから
 * 判断する —— 呼び出し側の並べ忘れで、新しい版を消してしまうのが
 * いちばん取り返しがつかない。
 */
export function selectRevisionsToPrune<T extends { version: number }>(revisions: T[], max: number = MAX_REVISIONS): T[] {
  return [...revisions].sort((a, b) => b.version - a.version).slice(max);
}

async function pruneRevisions(documentId: string): Promise<void> {
  const all = await listRevisions(documentId);
  for (const old of selectRevisionsToPrune(all)) {
    const { errors } = await serverDataClient.models.KnowledgeDocumentRevision.delete({ id: old.id }, inventoryAuthMode);
    // 古い版を消せなくても、保存自体は成功している。次の保存でもう一度試される。
    if (errors) console.warn("[knowledge] 古い版の削除に失敗", { documentId, version: old.version });
  }
}

export type KnowledgeEditResult =
  | { ok: true; document: KnowledgeDocumentRecord }
  | { ok: false; reason: "CONFLICT"; message: string; currentVersion: number }
  | { ok: false; reason: "NOT_FOUND" | "VALIDATION" | "FAILED"; message: string };

/**
 * 画面から本文を編集して保存する。
 *
 * @param expectedVersion 編集を始めた時点の version。
 *   これが現在と違えば、**別の誰かが先に保存している**。古い画面の内容で
 *   上書きすると相手の変更が消えるので、保存せずに知らせる(§競合検知)。
 */
export async function saveKnowledgeBody(params: {
  documentId: string;
  body: string;
  expectedVersion: number;
  who: string | null;
}): Promise<KnowledgeEditResult> {
  const current = await getKnowledgeDocument(params.documentId);
  if (!current) return { ok: false, reason: "NOT_FOUND", message: "対象のナレッジ文書が見つかりません。" };

  if (current.version !== params.expectedVersion) {
    return {
      ok: false,
      reason: "CONFLICT",
      message: `別の操作でこの文書が更新されています(編集開始時 v${params.expectedVersion} → 現在 v${current.version})。画面を再読み込みして、最新の内容から編集し直してください。`,
      currentVersion: current.version,
    };
  }

  // 上書きする前の中身を版として残す。ここで失敗したら保存へ進まない ——
  // 「戻せないまま上書きされた」が一番困る状態だから。
  const before = await readKnowledgeContent(params.documentId);
  const { errors: revisionErrors } = await serverDataClient.models.KnowledgeDocumentRevision.create(
    {
      documentId: params.documentId,
      version: current.version,
      title: current.title,
      body: before?.content ?? null,
      changeType: "MANUAL_EDIT",
      changedBy: params.who ?? undefined,
      changedAt: new Date().toISOString(),
    },
    inventoryAuthMode,
  );
  if (revisionErrors) {
    return { ok: false, reason: "FAILED", message: `保存前の版を記録できなかったため中止しました: ${revisionErrors.map((e) => e.message).join("; ")}` };
  }

  const saved = await replaceKnowledgeContent(
    params.documentId,
    { fileName: current.originalFileName, mimeType: current.mimeType || "text/plain", content: params.body },
    params.who,
  );
  if (!saved.ok) return { ok: false, reason: "VALIDATION", message: saved.errors.join(" / ") };

  await pruneRevisions(params.documentId);
  return { ok: true, document: saved.document };
}

/**
 * 指定した版の中身で復元する。
 *
 * 「いきなり上書きしない」という要件は、**画面側が中身を見せてから
 * このAPIを呼ぶ**ことで満たす(この関数自体は呼ばれたら実行する)。
 * 復元も1つの変更として扱うので、現在版はここでも履歴へ積まれる。
 */
export async function restoreKnowledgeRevision(params: {
  documentId: string;
  revisionId: string;
  expectedVersion: number;
  who: string | null;
}): Promise<KnowledgeEditResult> {
  const revisions = await listRevisions(params.documentId);
  const target = revisions.find((r) => r.id === params.revisionId);
  if (!target) return { ok: false, reason: "NOT_FOUND", message: "指定された版が見つかりません。" };
  if (target.body === null) return { ok: false, reason: "FAILED", message: "この版には本文が記録されていないため復元できません。" };

  const result = await saveKnowledgeBody({
    documentId: params.documentId,
    body: target.body,
    expectedVersion: params.expectedVersion,
    who: params.who,
  });
  if (!result.ok) return result;

  // 直前に積んだ版へ「復元だった」ことを書き残す。あとから履歴を見て
  // 「なぜここで内容が戻っているのか」が分かるようにする。
  const latest = (await listRevisions(params.documentId))[0];
  if (latest) {
    await serverDataClient.models.KnowledgeDocumentRevision.update(
      { id: latest.id, changeType: "RESTORE", restoredFromVersion: target.version },
      inventoryAuthMode,
    );
  }
  return result;
}
