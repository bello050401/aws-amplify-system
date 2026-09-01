"use client";

import type { MarkdownBlock, MarkdownInline } from "@/lib/knowledge/markdown";
import { parseMarkdown } from "@/lib/knowledge/markdown";

/**
 * §5.4 Markdownのプレビュー。
 *
 * dangerouslySetInnerHTMLを一切使わない。lib/knowledge/markdown.tsが
 * 返す構造化トークンからReact要素を組み立てるだけなので、本文に
 * `<script>` が書かれていてもReactが文字列としてエスケープする。
 * 「サニタイズ漏れ」という失敗の形がそもそも存在しない。
 */
export function MarkdownPreview({ source, plain }: { source: string; plain: boolean }) {
  if (plain) {
    // .txtはMarkdownとして解釈しない。書かれたとおりに見せる。
    return <pre className="whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed text-gray-800">{source}</pre>;
  }
  return <div className="space-y-2 text-[12px] leading-relaxed text-gray-800">{parseMarkdown(source).map(renderBlock)}</div>;
}

function renderBlock(block: MarkdownBlock, index: number) {
  switch (block.type) {
    case "heading": {
      const size = block.level <= 2 ? "text-[14px] font-bold" : "text-[13px] font-bold";
      return (
        <p key={index} className={`${size} text-gray-900`}>
          {block.inline.map(renderInline)}
        </p>
      );
    }
    case "paragraph":
      return <p key={index}>{block.inline.map(renderInline)}</p>;
    case "list":
      return block.ordered ? (
        <ol key={index} className="list-decimal space-y-0.5 pl-5">
          {block.items.map((item, i) => (
            <li key={i}>{item.map(renderInline)}</li>
          ))}
        </ol>
      ) : (
        <ul key={index} className="list-disc space-y-0.5 pl-5">
          {block.items.map((item, i) => (
            <li key={i}>{item.map(renderInline)}</li>
          ))}
        </ul>
      );
    case "code":
      return (
        <pre key={index} className="overflow-x-auto bg-gray-100 p-2 text-[11px] text-gray-800">
          {block.value}
        </pre>
      );
    case "quote":
      return (
        <p key={index} className="border-l-2 border-gray-300 pl-2 text-gray-600">
          {block.inline.map(renderInline)}
        </p>
      );
    case "hr":
      return <hr key={index} className="border-gray-200" />;
  }
}

function renderInline(node: MarkdownInline, index: number) {
  switch (node.type) {
    case "text":
      return <span key={index}>{node.value}</span>;
    case "bold":
      return <strong key={index}>{node.value}</strong>;
    case "italic":
      return <em key={index}>{node.value}</em>;
    case "code":
      return (
        <code key={index} className="bg-gray-100 px-1 text-[11px]">
          {node.value}
        </code>
      );
    case "link":
      // sanitizeLinkHrefを通ったURLだけがここへ来る(http/https/mailtoのみ)。
      // 社内文書から外部サイトへ飛ぶので、参照元は渡さない。
      return (
        <a key={index} href={node.href} target="_blank" rel="noopener noreferrer" className="text-blue-700 underline">
          {node.value}
        </a>
      );
  }
}
