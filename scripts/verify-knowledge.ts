/**
 * §5/§22/§23 ナレッジ文書管理の検証。外部サービスへは一切接続しない。
 *
 * Run with: npm run verify:knowledge
 *
 * ここで固定したいこと:
 *
 *  1. アップロードの検証(拡張子・MIME・サイズ・中身・ファイル名)を通らない
 *     ものを保存しない。
 *  2. ファイル名からディレクトリ区切りを取り除く(path traversal防止)。
 *     一方で**日本語のファイル名は壊さない** —— 「基本情報.txt」が
 *     「____.txt」になると、ダウンロードして何の文書か分からなくなる。
 *  3. Markdownのレンダリングで、HTMLもscriptも実行しない。危険なスキームの
 *     リンクをリンクにしない。
 *  4. 検索用テキストは記法を落として作る。上限を超えたら切り詰め、
 *     切り詰めたことが分かるようにする。
 *  5. §6/§7の初期文書の内容が、指定されたとおりであること。
 */
import { extensionOf, looksLikeText, sanitizeFileName, validateKnowledgeUpload } from "@/lib/knowledge/validation";
import { KNOWLEDGE_ALLOWED_EXTENSIONS, KNOWLEDGE_MAX_FILE_BYTES, KNOWLEDGE_SEARCH_TEXT_MAX_CHARS } from "@/lib/knowledge/limits";
import { markdownToPlainText, parseInline, parseMarkdown, sanitizeLinkHref } from "@/lib/knowledge/markdown";
import { buildSearchText } from "@/lib/knowledge/store";
import { KNOWLEDGE_SEED_BASIC_INFO, KNOWLEDGE_SEED_REPLY_RULES } from "@/lib/knowledge/seed";
import { MAX_REVISIONS, selectRevisionsToPrune } from "@/lib/knowledge/revisions";

let failures = 0;
let passes = 0;

function assertEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ FAIL ${label}\n    expected: ${e}\n    actual:   ${a}`);
  } else {
    passes++;
    console.log(`✓ ${label}`);
  }
}

function assertTrue(cond: boolean, label: string) {
  assertEqual(cond, true, label);
}

function validate(overrides: Partial<Parameters<typeof validateKnowledgeUpload>[0]> = {}) {
  const text = overrides.decodedText ?? "BELLO 基本情報\n営業時間 平日9:00～17:00";
  const result = validateKnowledgeUpload({
    fileName: "基本情報.txt",
    mimeType: "text/plain",
    sizeBytes: Buffer.byteLength(text, "utf8"),
    decodedText: text,
    ...overrides,
  });
  return { ok: result.ok, codes: result.errors.map((e) => e.code), safeFileName: result.safeFileName };
}

// ── §22 アップロード検証 ──────────────────────────────────────────

function testUploadValidation() {
  assertTrue(validate().ok, "検証: 通常の日本語TXTは受け付ける");
  assertTrue(validate({ fileName: "ルール.md", mimeType: "text/markdown" }).ok, "検証: Markdownも受け付ける");
  assertTrue(
    validate({ fileName: "ルール.md", mimeType: "application/octet-stream" }).ok,
    "検証: Windowsから.mdを上げたときのapplication/octet-streamも受け付ける",
  );

  const badExt = validate({ fileName: "malware.exe", mimeType: "application/octet-stream" });
  assertTrue(!badExt.ok && badExt.codes.includes("BAD_EXTENSION"), "検証: 許可外の拡張子を弾く");

  const badMime = validate({ fileName: "doc.txt", mimeType: "application/pdf" });
  assertTrue(!badMime.ok && badMime.codes.includes("BAD_MIME"), "検証: 許可外のMIMEを弾く");

  const empty = validate({ decodedText: "", sizeBytes: 0 });
  assertTrue(!empty.ok && empty.codes.includes("EMPTY_FILE"), "検証: 空ファイルを弾く");

  const tooLarge = validate({ sizeBytes: KNOWLEDGE_MAX_FILE_BYTES + 1 });
  assertTrue(!tooLarge.ok && tooLarge.codes.includes("TOO_LARGE"), "検証: 上限を超えるサイズを弾く");

  // 拡張子が.txtでも中身がバイナリなら受け付けない。
  const binary = "\u0000\u0001\u0002\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD";
  const notText = validate({ decodedText: binary, sizeBytes: 10 });
  assertTrue(!notText.ok && notText.codes.includes("NOT_TEXT"), "検証: 拡張子が.txtでも中身がバイナリなら弾く");

  assertTrue(looksLikeText("普通の日本語テキスト\n改行あり\tタブあり"), "本文判定: 改行・タブを含む普通のテキストは通る");
  assertTrue(!looksLikeText(""), "本文判定: 空文字はテキストとして扱わない");

  assertEqual(KNOWLEDGE_ALLOWED_EXTENSIONS.length, 3, "検証: 許可拡張子は.txt/.md/.markdownの3つ");
}

// ── §22 ファイル名のsanitize ──────────────────────────────────────

function testFileNameSanitization() {
  assertEqual(sanitizeFileName("基本情報.txt"), "基本情報.txt", "ファイル名: 日本語のファイル名を壊さない");
  assertEqual(sanitizeFileName("../../etc/passwd"), "passwd", "ファイル名: 親ディレクトリ参照を取り除く");
  assertEqual(sanitizeFileName("C:\\Windows\\system32\\config.txt"), "config.txt", "ファイル名: Windowsのパス区切りも取り除く");
  assertEqual(sanitizeFileName("a<b>c:d|e?f*g.txt"), "a_b_c_d_e_f_g.txt", "ファイル名: Windowsで使えない文字を置き換える");
  assertEqual(sanitizeFileName(".hidden.txt"), "hidden.txt", "ファイル名: 先頭のドットを落とす");
  assertTrue(sanitizeFileName("a".repeat(300) + ".txt").length <= 180, "ファイル名: 長すぎる名前を切り詰める");

  assertEqual(extensionOf("基本情報.txt"), ".txt", "拡張子: 最後のドット以降を取る");
  assertEqual(extensionOf("a.b.markdown"), ".markdown", "拡張子: 複数のドットがあっても最後を取る");
  assertEqual(extensionOf("noext"), "", "拡張子: 無ければ空文字");

  // ディレクトリ区切りだけのファイル名は、sanitize後に中身が無くなる。
  const traversal = validate({ fileName: "../../" });
  assertTrue(!traversal.ok, "検証: sanitize後に名前が残らないファイル名を弾く");
}

// ── §5.4 Markdownの安全なレンダリング ─────────────────────────────

function testMarkdownSafety() {
  const blocks = parseMarkdown("# 見出し\n\n本文です。\n\n- 項目1\n- 項目2\n");
  assertEqual(blocks[0].type, "heading", "Markdown: 見出しを解釈する");
  assertEqual(blocks[1].type, "paragraph", "Markdown: 段落を解釈する");
  assertEqual(blocks[2].type, "list", "Markdown: 箇条書きを解釈する");

  // HTMLは要素として解釈されず、ただの文字列として残る(Reactが自動で
  // エスケープするので、画面上もタグではなく文字として出る)。
  const html = parseMarkdown('<script>alert(1)</script>\n<img src=x onerror="alert(1)">');
  const flat = JSON.stringify(html);
  assertTrue(!flat.includes('"type":"html"'), "Markdown: HTMLブロックという概念自体を持たない");
  assertTrue(flat.includes("script"), "Markdown: HTMLタグは文字列としてそのまま残る(要素にはならない)");

  assertEqual(sanitizeLinkHref("javascript:alert(1)"), null, "リンク: javascript:スキームを拒否する");
  assertEqual(sanitizeLinkHref("data:text/html,<script>"), null, "リンク: data:スキームを拒否する");
  assertEqual(sanitizeLinkHref("vbscript:msgbox"), null, "リンク: vbscript:スキームを拒否する");
  assertEqual(sanitizeLinkHref("/inventory/settings"), null, "リンク: 相対パスは許可しない");
  assertEqual(sanitizeLinkHref("https://example.com/"), "https://example.com/", "リンク: httpsは許可する");
  assertEqual(sanitizeLinkHref("mailto:info@example.com"), "mailto:info@example.com", "リンク: mailtoは許可する");

  const dangerous = parseInline("[クリック](javascript:alert(1))");
  assertTrue(!JSON.stringify(dangerous).includes("javascript:"), "リンク: 危険なリンクはURLごと落とす");
  assertTrue(JSON.stringify(dangerous).includes("クリック"), "リンク: 危険なリンクでも表示文字は残す(文意を変えない)");

  const inline = parseInline("**強調**と`コード`と[リンク](https://example.com)");
  assertEqual(
    inline.map((n) => n.type),
    ["bold", "text", "code", "text", "link"],
    "Markdown: 行内記法(強調・コード・リンク)を解釈する",
  );

  const code = parseMarkdown("```js\nconst x = 1;\n```");
  assertEqual(code[0].type, "code", "Markdown: コードブロックを解釈する");
  assertEqual(code[0].type === "code" ? code[0].value : null, "const x = 1;", "Markdown: コードブロックの中身をそのまま保つ");
}

// ── 検索用テキストの生成 ──────────────────────────────────────────

function testSearchTextBuilding() {
  const md = buildSearchText("rules.md", "# 見出し\n\n**強調**された本文");
  assertTrue(!md.text.includes("**"), "検索テキスト: Markdownの記法を落とす");
  assertTrue(md.text.includes("強調された本文"), "検索テキスト: 本文自体は残る");
  assertTrue(!md.truncated, "検索テキスト: 短い文書は切り詰めない");

  const txt = buildSearchText("info.txt", "**これはTXTなので記法ではない**");
  assertTrue(txt.text.includes("**"), "検索テキスト: .txtはMarkdownとして解釈しない");

  const long = buildSearchText("long.txt", "あ".repeat(KNOWLEDGE_SEARCH_TEXT_MAX_CHARS + 100));
  assertTrue(long.truncated, "検索テキスト: 上限を超えたら切り詰めたと分かる");
  assertEqual(long.text.length, KNOWLEDGE_SEARCH_TEXT_MAX_CHARS, "検索テキスト: 切り詰めは上限ちょうど");

  assertEqual(markdownToPlainText("- 項目1\n- 項目2"), "・項目1\n・項目2", "平文化: 箇条書きを読める形にする");
}

// ── §6/§7 初期文書の内容 ──────────────────────────────────────────

function testSeedContent() {
  assertTrue(KNOWLEDGE_SEED_BASIC_INFO.includes("埼玉県所沢市南永井939-1"), "初期文書: 指定された所在地が入っている");
  assertTrue(KNOWLEDGE_SEED_BASIC_INFO.includes("平日 9:00～17:00"), "初期文書: 指定された営業時間が入っている");
  assertTrue(KNOWLEDGE_SEED_REPLY_RULES.includes("推測して回答しない"), "初期文書: 指定された返信ルールが入っている");
  assertTrue(
    KNOWLEDGE_SEED_REPLY_RULES.includes("送料情報をこの文書に重複保持しない"),
    "初期文書: 送料をこの文書に重複させない旨が入っている(既存の配送DBが正本)",
  );
  assertTrue(KNOWLEDGE_SEED_REPLY_RULES.includes("人間が確認してから送信"), "初期文書: 自動送信しない旨が入っている");

  // 初期文書はそのまま登録されるので、アップロード検証を通る必要がある。
  const basic = validateKnowledgeUpload({
    fileName: "基本情報.txt",
    mimeType: "text/plain",
    sizeBytes: Buffer.byteLength(KNOWLEDGE_SEED_BASIC_INFO, "utf8"),
    decodedText: KNOWLEDGE_SEED_BASIC_INFO,
  });
  assertTrue(basic.ok, "初期文書: 基本情報.txtはアップロード検証を通る");

  const rules = validateKnowledgeUpload({
    fileName: "AI問い合わせ返信ルール.md",
    mimeType: "text/markdown",
    sizeBytes: Buffer.byteLength(KNOWLEDGE_SEED_REPLY_RULES, "utf8"),
    decodedText: KNOWLEDGE_SEED_REPLY_RULES,
  });
  assertTrue(rules.ok, "初期文書: AI問い合わせ返信ルール.mdはアップロード検証を通る");
}

/**
 * 版の保持数。「現在版＋直近2世代」という要件そのもの。
 * 消しすぎ(戻せない)も残しすぎ(消したはずの記述が残り続ける)も困るので、
 * 境界を固定しておく。
 */
function testRevisionPruning() {
  assertEqual(MAX_REVISIONS, 2, "revisions: 保持するのは直近2世代");

  const mk = (v: number) => ({ version: v });
  assertEqual(selectRevisionsToPrune([]), [], "revisions: 履歴が無ければ何も消さない");
  assertEqual(selectRevisionsToPrune([mk(1)]), [], "revisions: 1世代なら消さない");
  assertEqual(selectRevisionsToPrune([mk(2), mk(1)]), [], "revisions: ちょうど2世代なら消さない");
  assertEqual(
    selectRevisionsToPrune([mk(3), mk(2), mk(1)]).map((r) => r.version),
    [1],
    "revisions: 3世代目からは古いものを消す",
  );
  assertEqual(
    selectRevisionsToPrune([mk(5), mk(4), mk(3), mk(2), mk(1)]).map((r) => r.version),
    [3, 2, 1],
    "revisions: 新しい2つを残し、それより古いものを全部消す",
  );
  // 並び順に依存しないこと。呼び出し側が並べ忘れても新しい版を消さない。
  assertEqual(
    selectRevisionsToPrune([mk(1), mk(3), mk(2)]).map((r) => r.version),
    [1],
    "revisions: 入力がばらばらでも、消すのは常に古い方",
  );
}

function main() {
  testUploadValidation();
  testRevisionPruning();
  testFileNameSanitization();
  testMarkdownSafety();
  testSearchTextBuilding();
  testSeedContent();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
