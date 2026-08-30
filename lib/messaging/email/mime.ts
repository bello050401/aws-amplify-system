/**
 * BELLO統合業務OS指示書(2026-08-30) §53: Emailスレッド化のための
 * 純粋ロジック(AWS/Amplifyへ一切触れない)。RFC 5322の
 * In-Reply-To/Referencesヘッダは、メールクライアント側で「同じ
 * スレッドとして表示する」ための標準的な仕組み — 対応するMessage-Id
 * (このアプリではMessage.externalMessageIdに保存する)を積み上げて
 * いくことでスレッド全体を再構築できる。
 */

/** 件名の "Re: " 重複防止(既に付いていれば付け直さない — メールクライアントの一般的な挙動に合わせる)。 */
export function buildReplySubject(originalSubject: string | null): string {
  const base = originalSubject?.trim() || "お問い合わせ";
  return /^re:\s*/i.test(base) ? base : `Re: ${base}`;
}

export interface ThreadingHeaders {
  "In-Reply-To"?: string;
  References?: string;
}

/**
 * inReplyToMessageId: 直接返信する対象のMessage-Id。
 * priorReferenceIds: それ以前の会話全体のMessage-Id列(古い順)。
 * Referencesヘッダは「これまでの全Message-Idをスペース区切りで列挙」
 * するのがRFC 5322の慣習。
 */
export function buildThreadingHeaders(inReplyToMessageId: string | null, priorReferenceIds: string[]): ThreadingHeaders {
  if (!inReplyToMessageId) return {};
  const references = [...priorReferenceIds.filter((id) => id !== inReplyToMessageId), inReplyToMessageId];
  return { "In-Reply-To": inReplyToMessageId, References: references.join(" ") };
}
