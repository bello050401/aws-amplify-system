/**
 * 会話全体から、人による家具・照明選びの相談が約束されているかを判定する。
 * 後続メッセージが配送等の別件でも、過去の相談依頼を消さないため履歴も見る。
 *
 * ── 会話文脈への永続化(重要) ────────────────────────────────────
 *
 * この検出は渡された history だけを見る。history は呼び出し側が渡す
 * 「直近のやり取り」であって、際限なく全件を保持している保証は無い。
 * 相談依頼が届いたメッセージが history の window から外れると、この
 * 関数だけでは二度と reasons を再現できず、引き継ぎが消える。
 *
 * そのため、確定した引き継ぎ状態は ConversationContext.reviewReasons へ
 * 符号化して**恒久的に**保持する(encodeHandoffReviewReasons /
 * parseHandoffFromReviewReasons)。lib/inquiry/conversationContext.ts は
 * この変更の対象範囲外なので、新しい型を足す代わりに既存の
 * reviewReasons(uniqで重複除去しつつ、mergeConversationContextで**消さず
 * 積み増す**フィールド)へ載せる。mergeHumanHandoff は
 * 「一度必要になったら消えない」ことを保証する。ここの detectHumanHandoff は
 * 「今回・直近の履歴から読み取れる分」だけの純粋な信号抽出にとどめる。
 */
export interface HumanHandoffEvidence {
  required: boolean;
  reasons: string[];
  /** 判定の根拠になった実際の文(担当者が確認できるように、要約せず残す)。 */
  evidenceQuotes: string[];
  carriedOverFromHistory: boolean;
  status: HumanHandoffStatus;
  /** 引き継ぎが最初に必要と判定された時刻(ISO)。会話を通じて保持する。 */
  decidedAt: string | null;
  /** 担当者が次に行うべきこと。不要な場合は null。 */
  nextAction: string | null;
}

export type HumanHandoffStatus = "PENDING_STAFF_REVIEW" | "NOT_REQUIRED";

/** 引き継ぎが必要な場合に担当者へ示す、次に行うこと。 */
export const HUMAN_HANDOFF_NEXT_ACTION =
  "担当者が間取り・お部屋の状況・ご希望を確認し、提案または来店日程の調整を行ってください。";

const CONSULTATION_SIGNALS: { label: string; pattern: RegExp }[] = [
  { label: "空間全体の相談", pattern: /空間全体|部屋全体|お部屋全体/ },
  { label: "家具と照明の選定", pattern: /家具.{0,8}(照明|ライト)|照明.{0,8}家具/ },
  { label: "リビング・ダイニングの相談", pattern: /リビング.{0,4}ダイニング|リビングダイニング|LDK/i },
  { label: "間取りを使った相談", pattern: /間取り|図面|平面図/ },
  { label: "配置・コーディネート相談", pattern: /配置.{0,8}(相談|提案|シミュレーション)|コーディネート|家具選び/ },
];

/** 一致した文そのものを1文単位で切り出す(通知に出すため、長すぎないようにする)。 */
function quotesIn(text: string): { reason: string; quote: string }[] {
  const found: { reason: string; quote: string }[] = [];
  for (const { label, pattern } of CONSULTATION_SIGNALS) {
    const m = pattern.exec(text);
    if (!m) continue;
    const start = Math.max(text.lastIndexOf("\n", m.index), text.lastIndexOf("。", m.index)) + 1;
    const endCandidates = [text.indexOf("。", m.index), text.indexOf("\n", m.index)].filter((i) => i >= 0);
    const end = endCandidates.length > 0 ? Math.min(...endCandidates) + 1 : text.length;
    found.push({ reason: label, quote: text.slice(start, end).trim().slice(0, 120) });
  }
  return found;
}

/**
 * reason(理由ラベル) と quote(根拠の引用文) を **常に対で** 持つ。
 *
 * reasons と evidenceQuotes を別々に new Set() で重複除去すると、由来の
 * 違うマッチで件数がずれ、evidence.reasons[i] と evidence.evidenceQuotes[i]
 * が指す内容が食い違いうる。1つの理由につき最初に見つかった引用文を
 * 対応させ、reasons と evidenceQuotes の長さ・並び順を常に一致させる。
 */
function pairedReasonsAndQuotes(matches: { reason: string; quote: string }[]): { reasons: string[]; evidenceQuotes: string[] } {
  const quoteByReason = new Map<string, string>();
  const order: string[] = [];
  for (const m of matches) {
    if (!quoteByReason.has(m.reason)) {
      quoteByReason.set(m.reason, m.quote);
      order.push(m.reason);
    }
  }
  return { reasons: order, evidenceQuotes: order.map((r) => quoteByReason.get(r) ?? "") };
}

/**
 * 今回のメッセージと渡された履歴だけから読み取れる信号。
 * 会話全体を通じた永続化は mergeHumanHandoff が別途行う。
 */
export interface HumanHandoffSignal {
  required: boolean;
  /** reasons[i] の根拠が evidenceQuotes[i] (常に対で並ぶ)。 */
  reasons: string[];
  evidenceQuotes: string[];
  /** 今回の本文自体に信号があったか(履歴だけからの検出と区別する)。 */
  fromCurrentMessage: boolean;
}

export function detectHumanHandoff(input: {
  currentText: string;
  history: { direction: "INBOUND" | "OUTBOUND"; body: string }[];
}): HumanHandoffSignal {
  const currentMatches = quotesIn(input.currentText);
  const historyMatches = input.history.flatMap((message) => quotesIn(message.body));
  const { reasons, evidenceQuotes } = pairedReasonsAndQuotes([...currentMatches, ...historyMatches]);
  return {
    required: reasons.length > 0,
    reasons,
    evidenceQuotes,
    fromCurrentMessage: currentMatches.length > 0,
  };
}

/** ConversationContext に恒久保持する引き継ぎ状態。 */
export interface HumanHandoffContextState {
  required: boolean;
  reasons: string[];
  evidenceQuotes: string[];
  /** 最初に必要と判定した時刻(ISO)。一度立ったら以後は変えない。 */
  decidedAt: string | null;
}

export function emptyHumanHandoffState(): HumanHandoffContextState {
  return { required: false, reasons: [], evidenceQuotes: [], decidedAt: null };
}

/**
 * 過去に確定した引き継ぎ状態(prior)と、今回の信号(current)を合成する。
 *
 * **一度 required になったら、以後の合成結果も required のままにする。**
 * これが「後続メッセージで引き継ぎ状態を失わない」という不変条件そのもの。
 * reasons / evidenceQuotes も削らずに積み増す(担当者が経緯を追えるように)。
 */
export function mergeHumanHandoff(params: {
  prior: HumanHandoffContextState;
  current: HumanHandoffSignal;
  now: string;
}): HumanHandoffEvidence {
  const required = params.prior.required || params.current.required;
  // prior を先に積み、後から current で不足分だけ補う(既存の対応を上書きしない)。
  const quoteByReason = new Map<string, string>();
  const order: string[] = [];
  for (const [i, reason] of params.prior.reasons.entries()) {
    if (!quoteByReason.has(reason)) {
      quoteByReason.set(reason, params.prior.evidenceQuotes[i] ?? "");
      order.push(reason);
    }
  }
  for (const [i, reason] of params.current.reasons.entries()) {
    if (!quoteByReason.has(reason)) {
      quoteByReason.set(reason, params.current.evidenceQuotes[i] ?? "");
      order.push(reason);
    }
  }
  const reasons = order;
  const evidenceQuotes = order.map((r) => quoteByReason.get(r) ?? "");
  const decidedAt = params.prior.decidedAt ?? (params.current.required ? params.now : null);
  return {
    required,
    reasons,
    evidenceQuotes,
    // 今回の本文・今回渡された履歴には信号が無く、以前の会話から引き継いだ場合。
    // A signal found only in the supplied history is still a carried-over
    // handoff. `current.required` covers both the current message and history,
    // so use the explicit origin flag here.
    carriedOverFromHistory: required && !params.current.fromCurrentMessage,
    status: required ? "PENDING_STAFF_REVIEW" : "NOT_REQUIRED",
    decidedAt,
    nextAction: required ? HUMAN_HANDOFF_NEXT_ACTION : null,
  };
}

/**
 * 恒久保持: ConversationContext.reviewReasons への符号化(型を追加できない制約下の永続化)。
 *
 * lib/inquiry/conversationContext.ts はこの変更の対象範囲外(スコープ外)。
 * ConversationContext には既に「社内で確認が必要な理由」を積み増す
 * reviewReasons(uniqで重複除去、mergeConversationContextで**消さずに
 * 積み増す**フィールド)があるため、新しい型・新しいフィールドを足す
 * 代わりにここへ符号化して書き戻す。history の window から元メッセージが
 * 外れても、この文字列が会話に残る限り引き継ぎ状態を再現できる。
 */
const HANDOFF_MARKER_PREFIX = "家具・照明選び相談(担当者引き継ぎ, 判定:";
const HANDOFF_MARKER_RE = /^家具・照明選び相談\(担当者引き継ぎ, 判定:([^)]+)\): ([^|]+?)(?: \| 根拠: (.+))?$/;

export function encodeHandoffReviewReasons(evidence: HumanHandoffEvidence): string[] {
  if (!evidence.required || !evidence.decidedAt) return [];
  if (evidence.reasons.length === 0) return [];
  // reasons[i] と evidenceQuotes[i] は常に対で並ぶ(pairedReasonsAndQuotes参照)。
  return evidence.reasons.map((reason, i) => {
    const quote = evidence.evidenceQuotes[i];
    return `${HANDOFF_MARKER_PREFIX}${evidence.decidedAt}): ${reason}${quote ? ` | 根拠: ${quote}` : ""}`;
  });
}

/** 会話文脈の reviewReasons から、過去に確定した引き継ぎ状態を復元する。 */
export function parseHandoffFromReviewReasons(reviewReasons: string[]): HumanHandoffContextState {
  const matches = reviewReasons
    .map((r) => HANDOFF_MARKER_RE.exec(r))
    .filter((m): m is RegExpExecArray => m != null);
  if (matches.length === 0) return emptyHumanHandoffState();
  const decidedAt = matches.map((m) => m[1]).sort()[0] ?? null;
  // 各行は1つのreasonと(あれば)そのquoteを1対1で持つ。ここで別々にdedupせず、
  // 1件目に見つかった対応をそのまま保つ(reasons/evidenceQuotesの整合を保つ)。
  const quoteByReason = new Map<string, string>();
  const order: string[] = [];
  for (const m of matches) {
    const reason = m[2].trim();
    if (!quoteByReason.has(reason)) {
      quoteByReason.set(reason, m[3]?.trim() ?? "");
      order.push(reason);
    }
  }
  return {
    required: true,
    reasons: order,
    evidenceQuotes: order.map((r) => quoteByReason.get(r) ?? ""),
    decidedAt,
  };
}
