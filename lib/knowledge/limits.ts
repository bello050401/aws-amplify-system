/**
 * ナレッジ文書の上限値(§22)。1箇所にまとめて、UI・Server Action・
 * 検証スクリプトが同じ値を見るようにする。
 */

/**
 * 1ファイルの最大バイト数。
 *
 * TXT/MDの社内文書としては十分大きく、かつDynamoDBの1項目400KB制限に
 * 対して検索用テキストを載せても余裕がある大きさに取る。
 */
export const KNOWLEDGE_MAX_FILE_BYTES = 512 * 1024;

/**
 * DynamoDBへ載せる検索用テキストの最大文字数。
 *
 * 400KB制限に対する安全弁。日本語はUTF-8で1文字3バイトになるため、
 * 12万文字で約360KB —— 他の属性の分を残して10万文字とする。
 * 超えた分は切り詰め、searchTextTruncatedをtrueにして「検索に出ない
 * 部分がある」ことを画面で説明できるようにする。
 */
export const KNOWLEDGE_SEARCH_TEXT_MAX_CHARS = 100_000;

/** 許可する拡張子(§5.1)。将来PDFを足すならここから。 */
export const KNOWLEDGE_ALLOWED_EXTENSIONS = [".txt", ".md", ".markdown"] as const;

/** 許可するMIMEタイプ。ブラウザやOSによって同じ.mdでも複数の値が来る。 */
export const KNOWLEDGE_ALLOWED_MIME_TYPES = [
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "application/octet-stream", // Windowsから.mdを上げるとこれになることがある
  "",
] as const;

/** AIへ渡すナレッジ抜粋の合計上限(§8「全文書を毎回投げない」)。 */
export const KNOWLEDGE_CONTEXT_MAX_CHARS = 6000;
/** 1文書あたりの抜粋上限。 */
export const KNOWLEDGE_SNIPPET_MAX_CHARS = 1500;
/** AIへ渡す文書の最大件数。 */
export const KNOWLEDGE_MAX_DOCUMENTS = 4;
