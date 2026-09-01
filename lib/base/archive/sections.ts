/**
 * BASEの商品説明文を、BELLOが実際に使っているセクション構造へ分解する。
 *
 * ## 構造は推測ではなく実測
 *
 * Stagingで取得した実際の267商品を数えた結果(2026-09-02):
 *
 *   コンディション        266 (100%)  平均出現順  7.4
 *   ◎商品のご紹介         255 ( 96%)  平均出現順  0.0  ← 必ず先頭
 *   発送について          254 ( 95%)  平均出現順  6.4
 *   商品詳細             215 ( 81%)  平均出現順  1.6  ← 寸法はここ
 *   こんな空間を求めている方に 112 ( 42%)  平均出現順  1.2
 *   状態ランク基準         121 ( 45%)
 *   お取り置きについて      144 ( 54%)
 *   ご注意               57 ( 21%)
 *   サイズ               39 ( 15%)  平均出現順  2.2
 *
 * ここから読み取れる最も重要な事実は、**寸法は「商品のご紹介」ではなく
 * 「商品詳細」に置かれている**こと(出現順 0.0 と 1.6)。生成する説明文で
 * 紹介文の冒頭に W/D/H を並べてはいけない、という指示は、BELLO自身の
 * 過去の書き方と一致している。
 *
 * ## 純粋関数である理由
 *
 * ここはネットワークもDBも触らない。同じ入力から必ず同じ分解結果になる
 * ので、scripts/verify-base.ts で実データの断片を固定して回帰にかけられる。
 */

/** BELLOの説明文で実際に使われている標準セクション。上の実測順に並べてある。 */
export type BaseSectionKind =
  | "INTRO" // ◎商品のご紹介
  | "TARGET" // こんな空間を求めている方に
  | "DETAIL" // 商品詳細(寸法・素材・型番など)
  | "SIZE" // サイズ(単独見出しの場合)
  | "CONDITION" // コンディション / 商品の状態
  | "CONDITION_SCALE" // 状態ランク基準(定型の説明)
  | "SHIPPING" // 発送について
  | "RESERVATION" // お取り置きについて
  | "NOTICE" // ご注意
  | "LINKS" // 関連リンク / SALEアイテム
  | "OTHER";

export interface BaseSection {
  kind: BaseSectionKind;
  /** 実際に書かれていた見出し文字列(記号を除いたもの)。 */
  heading: string;
  /** 見出しの次の行から、次の見出しの直前までの本文。 */
  body: string;
  /** 説明文全体の中で何番目の見出しだったか(0始まり)。 */
  order: number;
}

/**
 * 見出し文字列 → 種別。実測で見つかった表記ゆれをすべて受ける。
 * 判定順が意味を持つ(「状態ランク基準」は「コンディション」より先に見る)。
 */
const HEADING_RULES: { kind: BaseSectionKind; test: RegExp }[] = [
  { kind: "INTRO", test: /^商品(?:の)?[ごご御]?紹介$/ },
  { kind: "TARGET", test: /^こんな(?:空間|お部屋|方)/ },
  { kind: "CONDITION_SCALE", test: /^状態ランク基準$/ },
  { kind: "CONDITION", test: /^(?:コンディション|商品の状態|状態)/ },
  { kind: "SHIPPING", test: /^(?:発送|配送|お届け)(?:について|方法)?$/ },
  { kind: "RESERVATION", test: /^お取り置き/ },
  { kind: "NOTICE", test: /^(?:ご注意|注意事項|ご了承)/ },
  { kind: "LINKS", test: /^(?:関連リンク|SALEアイテム|関連商品)$/ },
  { kind: "SIZE", test: /^(?:サイズ|寸法)$/ },
  { kind: "DETAIL", test: /^(?:商品詳細|詳細|商品情報|サイズ、素材、重量等について)$/ },
];

export function classifyHeading(heading: string): BaseSectionKind {
  const normalized = heading.replace(/[\s　]/g, "").replace(/[:：]$/, "");
  for (const rule of HEADING_RULES) {
    if (rule.test.test(normalized)) return rule.kind;
  }
  return "OTHER";
}

/** HTMLの改行タグを本物の改行にしてからタグを落とす。原文は書き換えない(戻り値が別物)。 */
export function toPlainText(input: string | null | undefined): string {
  if (!input) return "";
  return String(input)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

/**
 * 見出しらしい行かどうか。
 *
 * BELLOの実際の書式は「◎商品のご紹介」のように記号+短い語だけの行。
 * 本文中の普通の文を見出しと誤認しないよう、長さと句点の有無で絞る ——
 * 実測で見出しはすべて30文字以下、句点を含まない。
 */
const HEADING_SYMBOLS = "◎●○■□★☆▼▽◆◇【】〔〕";
const HEADING_LINE = new RegExp(`^[\\s　]*[${HEADING_SYMBOLS}]+[\\s　]*([^\\n]{1,30}?)[\\s　]*[${HEADING_SYMBOLS}]*[\\s　]*[:：]?[\\s　]*$`);

function headingOf(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const m = HEADING_LINE.exec(trimmed);
  if (!m) return null;
  const text = m[1].trim();
  if (!text || text.length > 30) return null;
  // 句点で終わる行は文であって見出しではない。実測の見出しに句点は無い。
  if (/[。！？]/.test(text)) return null;
  return text;
}

/**
 * 説明文をセクションへ分解する。見出しが1つも無ければ、全体を
 * 1つの INTRO 扱いにはせず OTHER として返す —— 「見出しが無かった」
 * という事実を、紹介文が取れたことと混同させないため。
 */
export function splitBaseDescription(description: string | null | undefined): BaseSection[] {
  const text = toPlainText(description);
  if (!text.trim()) return [];

  const lines = text.split("\n");
  const sections: BaseSection[] = [];
  let current: { heading: string; kind: BaseSectionKind; body: string[] } | null = null;
  let order = 0;

  for (const line of lines) {
    const heading = headingOf(line);
    if (heading !== null) {
      if (current) {
        sections.push({ kind: current.kind, heading: current.heading, body: current.body.join("\n").trim(), order: order++ });
      }
      current = { heading, kind: classifyHeading(heading), body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) {
    sections.push({ kind: current.kind, heading: current.heading, body: current.body.join("\n").trim(), order: order++ });
  }

  return sections;
}

/** 特定の種別のセクション本文を取り出す(最初の1つ)。 */
export function sectionBody(sections: BaseSection[], kind: BaseSectionKind): string | null {
  const found = sections.find((s) => s.kind === kind);
  return found?.body.trim() || null;
}
