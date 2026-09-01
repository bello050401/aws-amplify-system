/**
 * §5.4 Markdownの安全なレンダリング。純粋関数のみ。
 *
 * 【なぜMarkdownライブラリを入れないか】ここで必要なのは「社内文書を
 * 管理画面で読める形にする」だけで、Markdownの全仕様は要らない。一方、
 * 一般的なMarkdownレンダラはHTMLの通過を既定で許すか、オプションで
 * 許せてしまう。ナレッジ文書は人がアップロードするファイルなので、
 * `<script>`や`<img onerror=...>`が本文に入りうる。
 *
 * そこでHTMLを**一切生成しない**方針を採る。この関数が返すのは構造化
 * されたトークンで、Reactコンポーネント側が要素を組み立てる。
 * dangerouslySetInnerHTMLを使う余地がそもそも無いので、
 * 「サニタイズ漏れ」という失敗の形が発生しない。
 *
 * 生のHTMLタグが本文にあれば、タグとしてではなく**文字列として**表示
 * される(Reactが自動でエスケープする)。
 */

export type MarkdownInline =
  | { type: "text"; value: string }
  | { type: "bold"; value: string }
  | { type: "italic"; value: string }
  | { type: "code"; value: string }
  | { type: "link"; href: string; value: string };

export type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; inline: MarkdownInline[] }
  | { type: "paragraph"; inline: MarkdownInline[] }
  | { type: "list"; ordered: boolean; items: MarkdownInline[][] }
  | { type: "code"; value: string; language: string | null }
  | { type: "quote"; inline: MarkdownInline[] }
  | { type: "hr" };

/**
 * リンク先として許すスキーム。
 *
 * `javascript:` `data:` `vbscript:` を弾くのが目的。相対パスも許さない
 * ——ナレッジ文書内の相対リンクは管理画面の別ページを指してしまう。
 */
const SAFE_LINK_SCHEMES = ["http:", "https:", "mailto:"];

export function sanitizeLinkHref(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return SAFE_LINK_SCHEMES.includes(url.protocol.toLowerCase()) ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * 行内記法を解く。対応するのは `**強調**` `*斜体*` `` `コード` ``
 * `[表示文字](URL)` の4つだけ。それ以外は素のテキストとして残す。
 */
export function parseInline(text: string): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]*\]\([^)\s]+\))/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ type: "text", value: text.slice(last, idx) });
    const token = m[0];
    if (token.startsWith("`")) {
      out.push({ type: "code", value: token.slice(1, -1) });
    } else if (token.startsWith("**")) {
      out.push({ type: "bold", value: token.slice(2, -2) });
    } else if (token.startsWith("*")) {
      out.push({ type: "italic", value: token.slice(1, -1) });
    } else {
      const linkMatch = token.match(/^\[([^\]]*)\]\(([^)\s]+)\)$/);
      if (linkMatch) {
        const href = sanitizeLinkHref(linkMatch[2]);
        // 危険なスキームのリンクは、リンクにせず表示文字だけを残す。
        // 消してしまうと文意が変わるため、テキストとしては残す。
        if (href) out.push({ type: "link", href, value: linkMatch[1] });
        else out.push({ type: "text", value: linkMatch[1] });
      } else {
        out.push({ type: "text", value: token });
      }
    }
    last = idx + token.length;
  }
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out.length > 0 ? out : [{ type: "text", value: text }];
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listOrdered = false;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", inline: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };
  const flushList = () => {
    if (listItems.length === 0) return;
    blocks.push({ type: "list", ordered: listOrdered, items: listItems.map(parseInline) });
    listItems = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = line.match(/^```\s*([A-Za-z0-9_+-]*)\s*$/);
    if (fence) {
      flushAll();
      const language = fence[1] || null;
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      blocks.push({ type: "code", value: body.join("\n"), language });
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushAll();
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushAll();
      blocks.push({ type: "hr" });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushAll();
      blocks.push({ type: "heading", level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6, inline: parseInline(heading[2].trim()) });
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushAll();
      blocks.push({ type: "quote", inline: parseInline(quote[1]) });
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (listItems.length > 0 && ordered !== listOrdered) flushList();
      listOrdered = ordered;
      listItems.push((bullet ?? numbered)![1]);
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }
  flushAll();
  return blocks;
}

/** プレビューが無い環境(検索・AI投入)向けに、記法を落とした素のテキストを得る。 */
export function markdownToPlainText(source: string): string {
  return parseMarkdown(source)
    .map((block) => {
      switch (block.type) {
        case "heading":
        case "paragraph":
        case "quote":
          return inlineToPlain(block.inline);
        case "list":
          return block.items.map((item) => `・${inlineToPlain(item)}`).join("\n");
        case "code":
          return block.value;
        case "hr":
          return "";
      }
    })
    .filter((s) => s.length > 0)
    .join("\n");
}

function inlineToPlain(inline: MarkdownInline[]): string {
  return inline.map((node) => (node.type === "link" ? `${node.value}(${node.href})` : node.value)).join("");
}
