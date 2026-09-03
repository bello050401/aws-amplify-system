/**
 * .docx の抽出 (指示書 §9-3)。
 *
 * 本文・見出し・箇条書き・表・コメント・画像の有無を抽出する。
 * 外部リンク、マクロ、埋込みオブジェクトは一切実行・展開しない (§9-2)。
 * 画像は「存在すること」だけを返し、OCR は行わない (ADR-0001 §3)。
 */
import { listEntries, readEntry, ZipError } from "./zipReader.mjs";

const DOCUMENT_PART = "word/document.xml";
const COMMENTS_PART = "word/comments.xml";

function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&"); // 最後に &amp; を戻す (二重デコード防止)
}

/**
 * ある要素名のトップレベル要素を順番に切り出す。
 * 入れ子の同名要素 (表の中の表など) を誤って切らないよう深さを数える。
 */
function sliceTopLevel(xml, names) {
  const out = [];
  const tagRe = /<(\/?)(w:[A-Za-z0-9]+)([^>]*?)(\/?)>/g;
  let match;
  let capturing = null;
  let depth = 0;
  let start = 0;

  while ((match = tagRe.exec(xml)) !== null) {
    const [full, closing, name, , selfClosing] = match;
    if (!capturing) {
      if (!closing && !selfClosing && names.includes(name)) {
        capturing = name;
        depth = 1;
        start = match.index;
      }
      continue;
    }
    if (name !== capturing) continue;
    if (selfClosing) continue;
    if (closing) {
      depth -= 1;
      if (depth === 0) {
        out.push({ name: capturing, xml: xml.slice(start, match.index + full.length) });
        capturing = null;
      }
    } else {
      depth += 1;
    }
  }
  return out;
}

/** 段落 XML からプレーンテキストを組み立てる。 */
function paragraphText(pXml) {
  let text = "";
  const re = /<w:(t|tab|br|cr)(\s[^>]*)?(\/?)>/g;
  let match;
  while ((match = re.exec(pXml)) !== null) {
    const tag = match[1];
    if (tag === "tab") {
      text += "\t";
      continue;
    }
    if (tag === "br" || tag === "cr") {
      text += "\n";
      continue;
    }
    if (match[3] === "/") continue; // <w:t/>
    const close = pXml.indexOf("</w:t>", re.lastIndex);
    if (close < 0) break;
    text += decodeXmlEntities(pXml.slice(re.lastIndex, close));
    re.lastIndex = close + 6;
  }
  return text;
}

function paragraphStyle(pXml) {
  const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(pXml)?.[1] ?? null;
  const isList = /<w:numPr[\s>]/.test(pXml);
  let headingLevel = null;
  if (style) {
    const m = /^(?:Heading|heading|見出し)\s*(\d+)$/.exec(style);
    if (m) headingLevel = Number(m[1]);
    else if (/^Title$/i.test(style)) headingLevel = 1;
  }
  return { style, isList, headingLevel };
}

function parseTable(tblXml) {
  const rows = [];
  for (const row of sliceTopLevel(tblXml, ["w:tr"])) {
    const cells = sliceTopLevel(row.xml, ["w:tc"]).map((cell) =>
      sliceTopLevel(cell.xml, ["w:p"])
        .map((p) => paragraphText(p.xml))
        .join("\n")
        .trim(),
    );
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/**
 * @returns {{blocks:Array, text:string, tableCount:number, imageCount:number,
 *            hasImages:boolean, hasTables:boolean, comments:string[], warnings:string[]}}
 */
export function extractDocx(buffer) {
  const warnings = [];
  let entries;
  try {
    entries = listEntries(buffer);
  } catch (err) {
    if (err instanceof ZipError) throw err;
    throw new ZipError(`docx を開けません: ${err.message}`);
  }

  const documentEntry = entries.get(DOCUMENT_PART);
  if (!documentEntry) {
    throw new ZipError(
      `${DOCUMENT_PART} がありません。.doc (旧形式) の可能性があります。Word で「.docx」として保存し直してください。`,
    );
  }

  const xml = readEntry(buffer, documentEntry).toString("utf8");

  // マクロ・埋込みオブジェクトは実行しない。存在だけ警告する。
  if ([...entries.keys()].some((n) => /vbaProject\.bin$/i.test(n))) {
    warnings.push("この文書にはマクロ (VBA) が含まれています。マクロは一切実行していません。");
  }
  if ([...entries.keys()].some((n) => /^word\/embeddings\//i.test(n))) {
    warnings.push("埋込みオブジェクトが含まれています。展開・実行はしていません。");
  }

  const mediaNames = [...entries.keys()].filter((n) => /^word\/media\//i.test(n));
  const bodyStart = xml.indexOf("<w:body>");
  const body = bodyStart >= 0 ? xml.slice(bodyStart) : xml;

  const blocks = [];
  let tableCount = 0;

  for (const element of sliceTopLevel(body, ["w:p", "w:tbl"])) {
    if (element.name === "w:tbl") {
      const rows = parseTable(element.xml);
      tableCount += 1;
      blocks.push({ type: "table", rows });
      continue;
    }
    const text = paragraphText(element.xml).trim();
    const { style, isList, headingLevel } = paragraphStyle(element.xml);
    const hasInlineImage = /<w:drawing[\s>]|<w:pict[\s>]/.test(element.xml);
    if (!text && !hasInlineImage) continue;
    if (headingLevel) blocks.push({ type: "heading", level: headingLevel, text, style });
    else if (isList) blocks.push({ type: "listItem", text, style });
    else if (text) blocks.push({ type: "paragraph", text, style });
    if (hasInlineImage) blocks.push({ type: "image", text: text || "(画像)" });
  }

  const comments = [];
  const commentsEntry = entries.get(COMMENTS_PART);
  if (commentsEntry) {
    const commentsXml = readEntry(buffer, commentsEntry).toString("utf8");
    for (const c of sliceTopLevel(commentsXml, ["w:comment"])) {
      const t = sliceTopLevel(c.xml, ["w:p"])
        .map((p) => paragraphText(p.xml))
        .join("\n")
        .trim();
      if (t) comments.push(t);
    }
  }

  const text = blocks
    .map((b) => {
      if (b.type === "heading") return `${"#".repeat(Math.min(6, b.level))} ${b.text}`;
      if (b.type === "listItem") return `- ${b.text}`;
      if (b.type === "table") return b.rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
      if (b.type === "image") return `![画像] ${b.text}`;
      return b.text;
    })
    .filter(Boolean)
    .join("\n\n");

  if (mediaNames.length > 0) {
    warnings.push(
      `画像が ${mediaNames.length} 点含まれています。画像内の文字は読み取っていません。重要な指示が画像だけに書かれていないか確認してください。`,
    );
  }

  return {
    blocks,
    text,
    tableCount,
    imageCount: mediaNames.length,
    hasImages: mediaNames.length > 0,
    hasTables: tableCount > 0,
    comments,
    warnings,
  };
}
