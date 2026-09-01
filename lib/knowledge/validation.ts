/**
 * §22 アップロード時の検証。純粋関数のみ。
 *
 * ここを通らないものはS3にもDynamoDBにも書かない。検証をServer Action
 * 側の分岐に散らさず1箇所へ集めているのは、追加の入口(将来のAPI等)が
 * できても同じ規則が効くようにするため。
 */
import { KNOWLEDGE_ALLOWED_EXTENSIONS, KNOWLEDGE_ALLOWED_MIME_TYPES, KNOWLEDGE_MAX_FILE_BYTES } from "./limits";

export type KnowledgeValidationError =
  | { code: "EMPTY_FILE"; message: string }
  | { code: "TOO_LARGE"; message: string }
  | { code: "BAD_EXTENSION"; message: string }
  | { code: "BAD_MIME"; message: string }
  | { code: "BAD_FILENAME"; message: string }
  | { code: "NOT_TEXT"; message: string };

export interface KnowledgeValidationResult {
  ok: boolean;
  errors: KnowledgeValidationError[];
  /** 検証を通った場合の、保存に使う安全なファイル名。 */
  safeFileName: string;
  extension: string;
}

/**
 * ファイル名を安全な形へ直す(§22 filename sanitize / path traversal防止)。
 *
 * ディレクトリ区切りとNUL、Windowsで使えない文字、先頭のドットを落とす。
 * 日本語のファイル名はそのまま残す —— 「基本情報.txt」を「____.txt」に
 * してしまうと、ダウンロードしたときに何の文書か分からなくなる。
 */
export function sanitizeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return cleaned.slice(0, 180);
}

export function extensionOf(fileName: string): string {
  const idx = fileName.lastIndexOf(".");
  return idx >= 0 ? fileName.slice(idx).toLowerCase() : "";
}

/**
 * テキストとして扱えるか。
 *
 * 拡張子とMIMEは名乗るだけなので、中身も見る。UTF-8として復号したときに
 * 置換文字(U+FFFD)や制御文字が多いものは、拡張子が.txtでも実際には
 * バイナリなので受け付けない —— 検索テキストにもプレビューにも
 * ならないものをナレッジとして登録させない。
 */
export function looksLikeText(decoded: string): boolean {
  if (decoded.length === 0) return false;
  let bad = 0;
  for (const ch of decoded) {
    const code = ch.codePointAt(0)!;
    if (ch === "\uFFFD") bad++;
    else if (code < 0x20 && ch !== "\n" && ch !== "\r" && ch !== "\t") bad++;
  }
  return bad / decoded.length < 0.01;
}

export function validateKnowledgeUpload(input: {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  decodedText: string;
}): KnowledgeValidationResult {
  const errors: KnowledgeValidationError[] = [];
  const safeFileName = sanitizeFileName(input.fileName);
  const extension = extensionOf(safeFileName);

  if (!safeFileName || safeFileName === extension) {
    errors.push({ code: "BAD_FILENAME", message: "ファイル名が不正です。" });
  }
  if (input.sizeBytes <= 0) {
    errors.push({ code: "EMPTY_FILE", message: "空のファイルは登録できません。" });
  }
  if (input.sizeBytes > KNOWLEDGE_MAX_FILE_BYTES) {
    errors.push({
      code: "TOO_LARGE",
      message: `ファイルサイズが上限(${Math.floor(KNOWLEDGE_MAX_FILE_BYTES / 1024)}KB)を超えています。`,
    });
  }
  if (!KNOWLEDGE_ALLOWED_EXTENSIONS.includes(extension as (typeof KNOWLEDGE_ALLOWED_EXTENSIONS)[number])) {
    errors.push({
      code: "BAD_EXTENSION",
      message: `対応していない拡張子です(${KNOWLEDGE_ALLOWED_EXTENSIONS.join(" / ")}のみ)。`,
    });
  }
  const mime = (input.mimeType || "").toLowerCase().split(";")[0].trim();
  if (!KNOWLEDGE_ALLOWED_MIME_TYPES.includes(mime as (typeof KNOWLEDGE_ALLOWED_MIME_TYPES)[number])) {
    errors.push({ code: "BAD_MIME", message: `対応していない形式です(${input.mimeType})。` });
  }
  if (input.sizeBytes > 0 && !looksLikeText(input.decodedText)) {
    errors.push({ code: "NOT_TEXT", message: "テキストとして読み取れないファイルです。" });
  }

  return { ok: errors.length === 0, errors, safeFileName, extension };
}
