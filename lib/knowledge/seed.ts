import "server-only";
import { listKnowledgeDocuments, saveKnowledgeDocument } from "./store";
import { BUSINESS_RULE_SEEDS } from "./businessRules";

/**
 * §6/§7/§43 初期ナレッジの登録。
 *
 * 【コード内の固定値にしない理由】§7が明示的に「コード内固定値だけでは
 * なく管理可能なナレッジ/ポリシーとして登録する」と要求している。
 * 運用ルールも営業時間も、変わったときにデプロイを挟まずADMINが直せる
 * べきもの。ここにあるのは**初回の中身**であって、以後の正本は
 * 登録された文書のほうになる。
 *
 * 【冪等】同じタイトルの文書が既にあれば何もしない。設定画面を開くたびに
 * 実行されても増殖しないし、ADMINが中身を編集したあとに上書きもしない
 * (lib/inventory/masterSeed.tsと同じ考え方)。
 */

export const KNOWLEDGE_SEED_BASIC_INFO_TITLE = "基本情報";
export const KNOWLEDGE_SEED_REPLY_RULES_TITLE = "AI問い合わせ返信ルール";

/** §6 で指定された内容そのまま。 */
export const KNOWLEDGE_SEED_BASIC_INFO = `BELLO 基本情報

【所在地】
埼玉県所沢市南永井939-1

【営業時間】
平日 9:00～17:00
`;

/** §7 で指定された内容そのまま。 */
export const KNOWLEDGE_SEED_REPLY_RULES = `# BELLO AI問い合わせ返信ルール

## 基本方針

問い合わせに商品URL、BASE URL、商品名、SKU、商品コード等が含まれている場合、まず対象商品をBELLO在庫管理システム内から特定する。

商品に関する回答はBELLO在庫情報を最優先する。

在庫情報だけで分からない点がある場合は、必要な項目だけ外部調査する。

外部調査ではメーカー公式サイト、公式カタログ、公式取扱説明書等の一次情報を優先する。

外部調査を行っても確証が得られない情報については、推測して回答しない。

無理にすべての質問へ回答を埋める必要はない。

送料に関する問い合わせは、既存のらくらく家財配送データベースを参照する。送料情報をこの文書に重複保持しない。

回答は顧客向けの自然で丁寧な日本語とし、内部在庫情報、内部評価値、SKU、社内メモ、個人名、仕入価格、利益率等を不用意に顧客へ出さない。

AI返信は初期状態では自動送信せず、人間が確認してから送信する。
`;

const SEEDS: { title: string; fileName: string; mimeType: string; content: string; category: string; description: string }[] = [
  {
    title: KNOWLEDGE_SEED_BASIC_INFO_TITLE,
    fileName: "基本情報.txt",
    mimeType: "text/plain",
    content: KNOWLEDGE_SEED_BASIC_INFO,
    category: "店舗情報",
    description: "所在地・営業時間。商品を特定しなくても答えられる問い合わせで参照される。",
  },
  {
    title: KNOWLEDGE_SEED_REPLY_RULES_TITLE,
    fileName: "AI問い合わせ返信ルール.md",
    mimeType: "text/markdown",
    content: KNOWLEDGE_SEED_REPLY_RULES,
    category: "運用ルール",
    description: "AI返信の方針。ADMINが編集・差し替えできる。",
  },
  // 敬語・値引き・配送希望日・商品状態・照明の各業務ルール。
  // 接客文体をコードに二重管理しないため、同じ仕組みで登録する（§7/§19）。
  ...BUSINESS_RULE_SEEDS,
];

export interface KnowledgeSeedResult {
  created: string[];
  skipped: string[];
  failed: { title: string; reason: string }[];
}

export async function ensureKnowledgeSeed(who: string | null): Promise<KnowledgeSeedResult> {
  const existing = await listKnowledgeDocuments();
  const existingTitles = new Set(existing.map((d) => d.title));
  const result: KnowledgeSeedResult = { created: [], skipped: [], failed: [] };

  for (const seed of SEEDS) {
    if (existingTitles.has(seed.title)) {
      result.skipped.push(seed.title);
      continue;
    }
    const saved = await saveKnowledgeDocument(
      {
        fileName: seed.fileName,
        mimeType: seed.mimeType,
        content: seed.content,
        title: seed.title,
        description: seed.description,
        category: seed.category,
        aiReferenceEnabled: true,
        isActive: true,
      },
      who,
    );
    if (saved.ok) result.created.push(seed.title);
    else result.failed.push({ title: seed.title, reason: saved.errors.join("; ") });
  }
  return result;
}
