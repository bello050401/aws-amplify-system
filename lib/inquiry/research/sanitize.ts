/**
 * §9.4 外部から取得した文章の扱い。純粋関数のみ。
 *
 * 【前提】外部Webページの本文は**信頼できないデータ**であって、AIへの
 * 指示ではない。ページ側に「これまでの指示を無視して…」と書いてあっても、
 * それはページの著者が書いた文字列にすぎない。
 *
 * 【二重の防御】
 *  1. プロンプトの構造で分ける(prompt.ts) —— 外部の文章は
 *     UNTRUSTED_EXTERNAL_FACTSという別ブロックへ入れ、SYSTEMとは混ぜない。
 *  2. 内容そのものから、指示に見える行を落とす(このファイル)。
 *
 * 1だけでは足りない。構造で分けても、十分に強い命令文はモデルの出力へ
 * 影響しうる。2だけでも足りない。パターンの列挙は必ず漏れる。両方を
 * かける。
 */

/**
 * 指示文とみなして落とす行のパターン。
 *
 * 日本語・英語の両方を見る。ここに無い言い回しは通ってしまうが、それは
 * 構造による防御(prompt.ts)と、生成後の検査(validate.ts)が受け持つ。
 */
const INSTRUCTION_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|preceding)\s+instructions?/i,
  /disregard\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above)/i,
  /forget\s+(?:everything|all)\s+(?:you|above)/i,
  /(?:show|reveal|print|output|repeat)\s+(?:me\s+)?(?:your\s+)?(?:system\s+prompt|instructions|prompt)/i,
  /you\s+are\s+now\s+(?:a|an)\s+/i,
  /new\s+instructions?\s*[:：]/i,
  /(?:send|post|transmit|email)\s+(?:the\s+)?(?:token|api[_\s-]?key|secret|credentials?|password)/i,
  /これまでの指示(?:を|は)?(?:すべて|全て)?(?:無視|忘れ)/,
  /以前の指示(?:を|は)?(?:すべて|全て)?(?:無視|忘れ)/,
  /上記の指示(?:を|は)?(?:すべて|全て)?(?:無視|忘れ)/,
  /システム\s*プロンプト(?:を)?(?:表示|出力|教え)/,
  /(?:トークン|APIキー|秘密鍵|パスワード|認証情報)(?:を)?(?:送信|送って|出力|表示|教え)/,
  /あなたは(?:今から|これから)\s*[^\s]{0,20}(?:として|です)/,
  /この(?:文章|文言|テキスト)(?:を)?(?:そのまま)?(?:出力|返信|コピー)/,
];

/** ゼロ幅文字・方向制御文字。命令を隠す手口として使われるため落とす。 */
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

export interface SanitizedExternalText {
  text: string;
  /** 指示文とみなして落とした行(監査用。AIへは渡さない)。 */
  removedLines: string[];
  /** 何か落としたか。trueなら、そのページの信頼度を下げる根拠になる。 */
  injectionDetected: boolean;
}

/**
 * 外部テキストから、AIへの指示に見える部分を取り除く。
 *
 * 行ごとに判定する。1行でも該当すればその行だけを落とし、残りは使う
 * ——ページ全体を捨てると、正しい仕様情報まで失われるため。
 */
export function sanitizeExternalText(raw: string, maxChars = 4000): SanitizedExternalText {
  const normalized = raw.replace(INVISIBLE_CHARS, "").replace(/\r\n/g, "\n");
  const kept: string[] = [];
  const removedLines: string[] = [];
  for (const line of normalized.split("\n")) {
    if (INSTRUCTION_PATTERNS.some((re) => re.test(line))) {
      removedLines.push(line.trim().slice(0, 200));
      continue;
    }
    kept.push(line);
  }
  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, maxChars);
  return { text, removedLines, injectionDetected: removedLines.length > 0 };
}

/**
 * HTMLから本文らしき部分を取り出す。
 *
 * script/styleの中身は完全に捨てる —— タグを剥がすだけだとJavaScriptの
 * ソースコードが本文として残り、そこに書かれた文字列がAIへ渡ってしまう。
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * §9.4「外部サイトから取得した文章をそのまま長文コピーして返信しない」。
 *
 * 生成文が外部テキストの長い連続一致を含んでいないかを見る。
 * 一致長のしきい値は、日本語の定型的な言い回し(「〜となっております」)で
 * 誤検知しない程度に取る。
 */
export const MAX_ALLOWED_EXTERNAL_COPY_CHARS = 60;

export function findLongVerbatimCopy(output: string, externalText: string, minLength = MAX_ALLOWED_EXTERNAL_COPY_CHARS): string | null {
  const src = externalText.replace(/\s+/g, "");
  const out = output.replace(/\s+/g, "");
  if (src.length < minLength || out.length < minLength) return null;
  for (let i = 0; i + minLength <= out.length; i++) {
    const chunk = out.slice(i, i + minLength);
    if (src.includes(chunk)) return chunk;
  }
  return null;
}
