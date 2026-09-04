import "server-only";
import { cookies } from "next/headers";
import { createHash, randomUUID } from "node:crypto";
import { getUrl, remove, uploadData } from "aws-amplify/storage/server";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { runWithAmplifyServerContext } from "@/lib/amplify/serverUtils";
import { KNOWLEDGE_SEARCH_TEXT_MAX_CHARS } from "./limits";
import { markdownToPlainText } from "./markdown";
import { extensionOf, validateKnowledgeUpload } from "./validation";
import type { SearchableKnowledgeDocument } from "./retrieval";
import { fetchWithTimeout } from "@/lib/http/fetchWithTimeout";

/**
 * この経路の外部呼び出し。応答が返らないまま固まらないよう上限を持つ
 * （2026-09-04 健全化 PHASE 8 — lib/http/fetchWithTimeout.ts）。
 * どこが時間切れになったのかがログで分かるよう、名前を付けて渡す。
 */
const fetchExternal = (input: string | URL | Request, init?: RequestInit) =>
  fetchWithTimeout(input, init, { label: "ナレッジの取得元" });


/**
 * §5 ナレッジ文書の唯一の読み書き窓口(lib/messaging/service.tsと同じ
 * 「書き込みを1ファイルへ集約する」方針)。
 *
 * 原本はS3の `knowledge/` プレフィックス、検索用テキストはDynamoDB。
 * このファイルはS3キーの形を外へ漏らさない —— 呼び出し側は常に
 * ドキュメントIDだけを扱う。
 */

/** S3のプレフィックス。amplify/storage/resource.tsのknowledge/*と対応。 */
const KNOWLEDGE_PREFIX = "knowledge/";

export interface KnowledgeDocumentRecord {
  id: string;
  storageKey: string;
  originalFileName: string;
  title: string;
  description: string | null;
  category: string | null;
  mimeType: string;
  sizeBytes: number;
  searchText: string | null;
  searchTextTruncated: boolean;
  isActive: boolean;
  aiReferenceEnabled: boolean;
  checksum: string | null;
  version: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

type KnowledgeRow = {
  id: string;
  storageKey: string;
  originalFileName: string;
  title: string;
  description?: string | null;
  category?: string | null;
  mimeType: string;
  sizeBytes: number;
  searchText?: string | null;
  searchTextTruncated?: boolean | null;
  isActive?: boolean | null;
  aiReferenceEnabled?: boolean | null;
  checksum?: string | null;
  version?: number | null;
  sortOrder?: number | null;
  createdAt: string;
  updatedAt: string;
  createdBy?: string | null;
  updatedBy?: string | null;
};

function toRecord(row: KnowledgeRow): KnowledgeDocumentRecord {
  return {
    id: row.id,
    storageKey: row.storageKey,
    originalFileName: row.originalFileName,
    title: row.title,
    description: row.description ?? null,
    category: row.category ?? null,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    searchText: row.searchText ?? null,
    searchTextTruncated: row.searchTextTruncated ?? false,
    isActive: row.isActive ?? true,
    aiReferenceEnabled: row.aiReferenceEnabled ?? true,
    checksum: row.checksum ?? null,
    version: row.version ?? 1,
    sortOrder: row.sortOrder ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: row.createdBy ?? null,
    updatedBy: row.updatedBy ?? null,
  };
}

export async function listKnowledgeDocuments(): Promise<KnowledgeDocumentRecord[]> {
  const rows: KnowledgeRow[] = [];
  let nextToken: string | null | undefined;
  do {
    const { data, nextToken: nt, errors } = await serverDataClient.models.KnowledgeDocument.list({
      limit: 200,
      nextToken: nextToken ?? undefined,
      ...inventoryAuthMode,
    });
    // §19: Amplify Dataのerrorsを無視しない。空配列を「0件」として返すと、
    // 権限エラーや通信断が「文書が登録されていない」というまったく違う
    // 意味の画面になる。
    if (errors) throw new Error(`ナレッジ文書の取得に失敗しました: ${errors.map((e) => e.message).join("; ")}`);
    rows.push(...(data as unknown as KnowledgeRow[]));
    nextToken = nt;
  } while (nextToken);
  return rows.map(toRecord).sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title, "ja"));
}

/** 検索・AI参照に使う軽量な形。本文はsearchTextのみ(原本S3は読まない)。 */
export async function listSearchableKnowledge(): Promise<SearchableKnowledgeDocument[]> {
  const docs = await listKnowledgeDocuments();
  return docs.map((d) => ({
    id: d.id,
    title: d.title,
    originalFileName: d.originalFileName,
    description: d.description,
    category: d.category,
    searchText: d.searchText,
    isActive: d.isActive,
    aiReferenceEnabled: d.aiReferenceEnabled,
  }));
}

export async function getKnowledgeDocument(id: string): Promise<KnowledgeDocumentRecord | null> {
  const { data, errors } = await serverDataClient.models.KnowledgeDocument.get({ id }, inventoryAuthMode);
  if (errors) throw new Error(`ナレッジ文書の取得に失敗しました: ${errors.map((e) => e.message).join("; ")}`);
  return data ? toRecord(data as unknown as KnowledgeRow) : null;
}

/**
 * 検索用テキストを作る。
 *
 * Markdownは記法を落としてから入れる —— `**営業時間**` のままだと
 * 「営業時間」で検索したときに記号がノイズになるうえ、AIへ渡す抜粋にも
 * 記号が混ざる。
 */
export function buildSearchText(fileName: string, content: string): { text: string; truncated: boolean } {
  const ext = extensionOf(fileName);
  const plain = ext === ".md" || ext === ".markdown" ? markdownToPlainText(content) : content;
  const normalized = plain.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= KNOWLEDGE_SEARCH_TEXT_MAX_CHARS) return { text: normalized, truncated: false };
  return { text: normalized.slice(0, KNOWLEDGE_SEARCH_TEXT_MAX_CHARS), truncated: true };
}

export interface SaveKnowledgeInput {
  fileName: string;
  mimeType: string;
  /** ファイルの中身(UTF-8テキスト)。 */
  content: string;
  title: string;
  description: string | null;
  category: string | null;
  aiReferenceEnabled: boolean;
  isActive: boolean;
}

export type SaveKnowledgeResult = { ok: true; document: KnowledgeDocumentRecord } | { ok: false; errors: string[] };

/**
 * 新規登録。検証 → S3へ原本 → DynamoDBへメタデータ、の順。
 *
 * S3へ先に置くのは、DynamoDBの行だけができてS3に原本が無い状態
 * (ダウンロードすると404になる行)を作らないため。逆順の失敗
 * (S3に孤児オブジェクトが残る)のほうが害が小さい。
 */
export async function saveKnowledgeDocument(input: SaveKnowledgeInput, who: string | null): Promise<SaveKnowledgeResult> {
  const bytes = Buffer.from(input.content, "utf8");
  const validation = validateKnowledgeUpload({
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: bytes.byteLength,
    decodedText: input.content,
  });
  if (!validation.ok) return { ok: false, errors: validation.errors.map((e) => e.message) };

  const storageKey = `${KNOWLEDGE_PREFIX}${randomUUID()}${validation.extension}`;
  await putObject(storageKey, bytes, input.mimeType || "text/plain");

  const { text, truncated } = buildSearchText(validation.safeFileName, input.content);
  const checksum = createHash("sha256").update(bytes).digest("hex");

  const { data, errors } = await serverDataClient.models.KnowledgeDocument.create(
    {
      storageKey,
      originalFileName: validation.safeFileName,
      title: input.title.trim() || validation.safeFileName,
      description: input.description,
      category: input.category,
      mimeType: input.mimeType || "text/plain",
      sizeBytes: bytes.byteLength,
      searchText: text,
      searchTextTruncated: truncated,
      isActive: input.isActive,
      aiReferenceEnabled: input.aiReferenceEnabled,
      checksum,
      version: 1,
      sortOrder: Date.now() % 1_000_000,
      createdBy: who,
      updatedBy: who,
    },
    inventoryAuthMode,
  );
  if (errors || !data) {
    // DynamoDBへ書けなかったなら、いま置いたS3オブジェクトは誰からも
    // 参照されない。放置せず消す。
    await removeObject(storageKey).catch(() => undefined);
    return { ok: false, errors: [errors?.[0]?.message ?? "ナレッジ文書の保存に失敗しました。"] };
  }
  return { ok: true, document: toRecord(data as unknown as KnowledgeRow) };
}

/** メタデータだけの更新(タイトル・説明・カテゴリ・有効/無効・AI参照)。 */
export async function updateKnowledgeMetadata(
  id: string,
  patch: {
    title?: string;
    description?: string | null;
    category?: string | null;
    isActive?: boolean;
    aiReferenceEnabled?: boolean;
    sortOrder?: number;
  },
  who: string | null,
): Promise<KnowledgeDocumentRecord> {
  const { data, errors } = await serverDataClient.models.KnowledgeDocument.update({ id, ...patch, updatedBy: who }, inventoryAuthMode);
  if (errors || !data) throw new Error(errors?.[0]?.message ?? "ナレッジ文書の更新に失敗しました。");
  return toRecord(data as unknown as KnowledgeRow);
}

/**
 * 差し替え(§5.2)。新しい原本をS3へ置き、古い原本を消す。
 *
 * ドキュメントIDは変えない —— 既存の返信案の監査情報(sourceSummary)が
 * このIDで文書を指しているため、差し替えでIDが変わると過去の根拠が
 * 追えなくなる(§23)。versionを+1して「同じ文書の別版」であることを残す。
 */
export async function replaceKnowledgeContent(
  id: string,
  input: { fileName: string; mimeType: string; content: string },
  who: string | null,
): Promise<SaveKnowledgeResult> {
  const existing = await getKnowledgeDocument(id);
  if (!existing) return { ok: false, errors: ["対象のナレッジ文書が見つかりません。"] };

  const bytes = Buffer.from(input.content, "utf8");
  const validation = validateKnowledgeUpload({
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: bytes.byteLength,
    decodedText: input.content,
  });
  if (!validation.ok) return { ok: false, errors: validation.errors.map((e) => e.message) };

  const newKey = `${KNOWLEDGE_PREFIX}${randomUUID()}${validation.extension}`;
  await putObject(newKey, bytes, input.mimeType || "text/plain");

  const { text, truncated } = buildSearchText(validation.safeFileName, input.content);
  const { data, errors } = await serverDataClient.models.KnowledgeDocument.update(
    {
      id,
      storageKey: newKey,
      originalFileName: validation.safeFileName,
      mimeType: input.mimeType || "text/plain",
      sizeBytes: bytes.byteLength,
      searchText: text,
      searchTextTruncated: truncated,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      version: existing.version + 1,
      updatedBy: who,
    },
    inventoryAuthMode,
  );
  if (errors || !data) {
    await removeObject(newKey).catch(() => undefined);
    return { ok: false, errors: [errors?.[0]?.message ?? "ナレッジ文書の差し替えに失敗しました。"] };
  }
  // 旧原本の削除は差し替え成功後に行う。ここで失敗しても文書自体は正しく
  // 差し替わっているので、例外にはせず孤児オブジェクトとして残す。
  await removeObject(existing.storageKey).catch((err) => {
    console.warn("[knowledge] 旧原本の削除に失敗しました(文書の差し替え自体は成功)", { id, err: String(err) });
  });
  return { ok: true, document: toRecord(data as unknown as KnowledgeRow) };
}

export async function deleteKnowledgeDocument(id: string): Promise<void> {
  const existing = await getKnowledgeDocument(id);
  if (!existing) return;
  const { errors } = await serverDataClient.models.KnowledgeDocument.delete({ id }, inventoryAuthMode);
  if (errors) throw new Error(errors[0]?.message ?? "ナレッジ文書の削除に失敗しました。");
  await removeObject(existing.storageKey).catch((err) => {
    console.warn("[knowledge] 原本の削除に失敗しました(メタデータは削除済み)", { id, err: String(err) });
  });
}

/**
 * 原本の中身を返す(§5.3 ダウンロード / §5.4 プレビュー)。
 *
 * 恒久的な公開URLは作らない(§22)。**署名付きURLをブラウザへ渡さず**、
 * 認証済みのServer Actionが中身そのものを返す —— URLが利用者の手元へ
 * 出ない以上、それが転送されたり履歴に残ったりする経路が存在しない。
 *
 * @aws-amplify/storageのサーバー側APIには「オブジェクトのバイト列を
 * 直接取得する」呼び出しが無い(uploadData/getUrl/remove/copy/list/
 * getPropertiesのみ)。そのため、このサーバー自身が短時間有効の
 * presigned GET URLを作って自分で取得する —— lib/inventory/
 * imageServerOps.tsのcomputeOriginalHashForPathと同じ手法で、
 * URLはこのプロセスの外へ出ない。
 */
export async function readKnowledgeContent(id: string): Promise<{ fileName: string; mimeType: string; content: string } | null> {
  const doc = await getKnowledgeDocument(id);
  if (!doc) return null;
  const { url } = await runWithAmplifyServerContext({
    nextServerContext: { cookies },
    operation: (contextSpec) => getUrl(contextSpec, { path: doc.storageKey }),
  });
  const res = await fetchExternal(url);
  if (!res.ok) throw new Error(`ナレッジ文書の原本を取得できませんでした (HTTP ${res.status})。`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return { fileName: doc.originalFileName, mimeType: doc.mimeType, content: bytes.toString("utf8") };
}

async function putObject(path: string, bytes: Buffer, contentType: string): Promise<void> {
  await runWithAmplifyServerContext({
    nextServerContext: { cookies },
    operation: (contextSpec) => uploadData(contextSpec, { path, data: bytes, options: { contentType } }).result,
  });
}

async function removeObject(path: string): Promise<void> {
  await runWithAmplifyServerContext({
    nextServerContext: { cookies },
    operation: (contextSpec) => remove(contextSpec, { path }),
  });
}
