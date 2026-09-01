import "server-only";
import { generateText } from "@/lib/ai/gateway/gateway";
import { listSearchableKnowledge } from "@/lib/knowledge/store";
import { retrieveKnowledge } from "@/lib/knowledge/retrieval";
import { KEIGO_RULES_TITLE, FIRST_REPLY_GREETING } from "@/lib/knowledge/businessRules";
import {
  buildKeigoSystemPrompt,
  buildKeigoUserPrompt,
  checkKeigoFidelity,
  detectAmbiguity,
  isFirstOutgoingReply,
  type KeigoViolation,
} from "./keigo";

/**
 * §4.2/§6 「敬語に整える」の実行層。
 *
 * 【この経路が絶対にしないこと】Web検索、BASE API、商品検索、配送DB、
 * 外部API。スタッフが既に答えを決めていて、言い方だけを整えたい場面
 * だからで、そこで商品を調べ直すのは遅くなるだけでなく、下書きに無い
 * 事実が混ざる入口になる。
 *
 * この関数がimportしているものを見れば、その保証が読み取れる ——
 * productResolver も research も shipping も入っていない。
 */

const KEIGO_PROMPT_VERSION = "keigo-rewrite-v1";
/** 再生成は1回だけ。直らないものを何度も投げてもコストが増えるだけ。 */
const MAX_ATTEMPTS = 2;

export interface KeigoRewriteResult {
  ok: boolean;
  /** 整えた本文。失敗時はnull。 */
  text: string | null;
  /** 初回挨拶を付けたか。 */
  greetingApplied: boolean;
  /** §6.3 スタッフ向けの注意（顧客には出さない）。 */
  ambiguityNotes: string[];
  /** 事実保持の検査で見つかった問題。 */
  violations: KeigoViolation[];
  /** 参照した社内文書（監査用）。 */
  knowledgeTitles: string[];
  modelProvider: string | null;
  modelName: string | null;
  failureReason: string | null;
}

export async function rewriteAsKeigo(params: {
  original: string;
  /** 会話の全メッセージ。初回判定に使う。 */
  messages: { direction: "INBOUND" | "OUTBOUND"; deliveryStatus: string; body: string }[];
}): Promise<KeigoRewriteResult> {
  const original = params.original.trim();
  if (original.length === 0) {
    return {
      ok: false,
      text: null,
      greetingApplied: false,
      ambiguityNotes: [],
      violations: [],
      knowledgeTitles: [],
      modelProvider: null,
      modelName: null,
      failureReason: "整える対象の文章が空です。",
    };
  }

  // §6.1 実際に送信した返信が無ければ初回。AI下書きは「返信済み」にしない。
  const firstReply = isFirstOutgoingReply(params.messages);
  const greeting = firstReply ? FIRST_REPLY_GREETING : null;

  // 敬語ルールの文書だけを引く。全ナレッジを投げない（§19）。
  let knowledgeExcerpts: { title: string; excerpt: string }[] = [];
  try {
    const docs = await listSearchableKnowledge();
    const keigoDoc = docs.find((d) => d.title === KEIGO_RULES_TITLE && d.isActive && d.aiReferenceEnabled);
    if (keigoDoc?.searchText) {
      knowledgeExcerpts = [{ title: keigoDoc.title, excerpt: keigoDoc.searchText.slice(0, 2500) }];
    } else {
      // タイトルが変更されている場合に備えて、検索でも拾ってみる。
      knowledgeExcerpts = retrieveKnowledge(docs, "敬語 返信 文体 挨拶", { maxDocuments: 1 }).map((h) => ({
        title: h.document.title,
        excerpt: h.snippet,
      }));
    }
  } catch (err) {
    // ナレッジが読めなくても敬語変換自体は成立する。黙って0件にせず記録する。
    console.warn("[keigo] 敬語ルールの文書を読めませんでした", { error: err instanceof Error ? err.name : "unknown" });
  }

  const ambiguityNotes = detectAmbiguity(original);
  const systemPrompt = buildKeigoSystemPrompt();
  const userPrompt = buildKeigoUserPrompt({
    original,
    knowledgeExcerpts,
    greeting,
  });

  let lastViolations: KeigoViolation[] = [];
  let modelProvider: string | null = null;
  let modelName: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let output: string;
    try {
      const result = await generateText({
        task: "CUSTOMER_REPLY_DRAFT",
        systemPrompt:
          attempt === 1
            ? systemPrompt
            : `${systemPrompt}\n\n【前回の出力で検出された問題（必ず直すこと）】\n${lastViolations.map((v) => `- ${v.detail}`).join("\n")}`,
        userPrompt,
        tier: "STANDARD",
        promptVersion: KEIGO_PROMPT_VERSION,
      });
      output = result.output.trim();
      modelProvider = result.providerId;
      modelName = result.modelId;
    } catch (err) {
      return {
        ok: false,
        text: null,
        greetingApplied: false,
        ambiguityNotes,
        violations: [],
        knowledgeTitles: knowledgeExcerpts.map((k) => k.title),
        modelProvider,
        modelName,
        failureReason: err instanceof Error ? err.message : "AIの呼び出しに失敗しました。",
      };
    }

    const check = checkKeigoFidelity({ original, rewritten: output, allowedGreeting: greeting ?? undefined });
    if (check.ok) {
      return {
        ok: true,
        text: output,
        greetingApplied: Boolean(greeting) && output.includes(FIRST_REPLY_GREETING.split("\n")[0]),
        ambiguityNotes,
        violations: [],
        knowledgeTitles: knowledgeExcerpts.map((k) => k.title),
        modelProvider,
        modelName,
        failureReason: null,
      };
    }
    lastViolations = check.violations;
    console.warn("[keigo] 事実保持の検査に不合格", { attempt, codes: check.violations.map((v) => v.code) });
  }

  return {
    ok: false,
    text: null,
    greetingApplied: false,
    ambiguityNotes,
    violations: lastViolations,
    knowledgeTitles: knowledgeExcerpts.map((k) => k.title),
    modelProvider,
    modelName,
    failureReason: `整えた文章が原文の事実を変えていたため採用しませんでした: ${lastViolations.map((v) => v.detail).join(" / ")}`,
  };
}
