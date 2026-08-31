/**
 * 「AIへ渡してよい事実」を組み立てる層(夜間統合指示書 2026-09-01 §4.7)。
 *
 * ## なぜ必要か —— 実データで確認した2つの事故経路
 *
 * 2026-09-01に本番Inventory 300件を実測したところ、次が分かった。
 *
 * ### 1. `conditionRating` は顧客向けの文章ではなく、社内の5段階評価
 *
 * 実際の値の分布(300件中118件が設定済み、平均2文字):
 *   "3.5"×59 / "4"×38 / "3"×10 / "5"×8 / "2.5"×1 / "4.5"×1 / "4.0"×1
 *
 * ところが`app/actions/ai.ts`はこれを`conditionNote`としてそのまま
 * プロンプトへ渡し、`buildListingUserPrompt`が「コンディション: 4」と
 * 描画していた。モデルはそれに忠実に従って
 * **「コンディションは4です」** と書く —— 報告されていた品質問題は
 * モデルの捏造ではなく、**社内スコアを顧客向けプロンプトへ入れていた**
 * ことが原因だった。数値は顧客にとって意味が無く、出してはいけない。
 *
 * 一方、顧客に本当に伝えるべき状態説明は `damageNotes`
 * (300件中137件、平均14文字。例:「ウレタンヘタりあり。2脚中1脚は
 * 背もたれ上部と背面に若干の布破れがあり」)にあるのに、
 * **AIへ一切渡されていなかった**。渡すものと渡さないものが逆だった。
 *
 * ### 2. `note` には顧客の住所が入っていることがある
 *
 * 同じ実測で、`note` の中に郵便番号+都道府県+丁目を含む
 * **顧客の配送先住所** が入っている行が見つかった(300件中2件。
 * 商品名自体が「【指定なし：住所注意備考欄】」となっているものも4件)。
 * `note`はそのままAIプロンプトへ渡され、生成結果は顧客向けの商品説明に
 * なる —— つまり **他人の住所が公開商品ページに載り得る** 経路だった。
 *
 * そこでこの層で、渡す前に「顧客向けに出してよい事実」だけへ絞り込む。
 * 数値スコアは落とし、住所らしき記述は落とし、状態説明は damageNotes
 * から取る。落とした事実は「無いもの」として扱い、捏造で埋めない。
 */

/** 顧客向けの生成に渡してよい、検証済みの事実。ここに無いものをAIは書いてはいけない。 */
export interface CustomerSafeFacts {
  /** 商品名(BELLOの在庫名。ブランド名は通常この中に含まれる)。 */
  name: string;
  /** 寸法(整形済み文字列)。不明ならnull。 */
  dimensions: string | null;
  /** カテゴリー名。 */
  categoryName: string | null;
  /** 顧客へ開示すべき状態・傷の説明(damageNotes由来)。 */
  conditionDisclosure: string | null;
  /** 商品に関する備考のうち、顧客向けに出して安全と判断できた部分。 */
  publicNote: string | null;
}

/** 事実を組み立てる際に落とした情報の記録(監査・デバッグ用。顧客には出さない)。 */
export interface FactRedaction {
  field: string;
  reason: "INTERNAL_SCORE" | "POSSIBLE_PERSONAL_DATA" | "EMPTY" | "INTERNAL_MARKER" | "PRICE";
  /** 取り除いた内容の要約(監査用。秘密値そのものは入れない)。 */
  detail?: string;
}

export interface BuildFactsResult {
  facts: CustomerSafeFacts;
  redactions: FactRedaction[];
}

/**
 * 社内評価スコアかどうか。"4" / "3.5" / "4.0" / "５" のような、
 * 数値だけ(全角含む)の短い値を指す。
 *
 * これに該当するものは顧客向けの文章には一切出さない —— 「コンディション
 * ランク4」のような社内語彙をそのまま客へ見せない、という判断。
 */
export function isInternalConditionScore(value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[．]/g, ".");
  if (!normalized) return false;
  return /^\d+(?:\.\d+)?$/.test(normalized);
}

/**
 * 個人情報(住所・電話番号)らしき記述を含むか。
 *
 * 完全な判定は不可能なので、**疑わしければ落とす** 側に倒す。
 * 商品説明として本当に必要な情報がここで巻き添えになることはあり得るが、
 * 顧客の住所が公開ページへ出る事故に比べれば圧倒的に軽い。
 */
export function looksLikePersonalData(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  // 郵便番号(123-4567)
  if (/\b\d{3}\s*[-−ー－]\s*\d{4}\b/.test(t)) return true;
  // 電話番号
  if (/\b0\d{1,4}[-−ー－]\d{1,4}[-−ー－]\d{3,4}\b/.test(t)) return true;
  // 都道府県 + 市区町村郡
  if (/(北海道|東京都|大阪府|京都府|[^\s]{2,3}県)\s*[^\s]{1,12}?(市|区|郡|町|村)/.test(t)) return true;
  // 丁目・番地(番地単独は誤検知しやすいので丁目と併記のときだけ)
  if (/\d+\s*丁目/.test(t)) return true;
  return false;
}

function trimmedOrNull(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

/**
 * 商品名の先頭等に付く `【…】` の社内マーカーを取り除く。
 *
 * ## 実測して分かったこと(本番Inventory 300件)
 *
 * 300件中 **190件(63%)** の商品名に `【…】` が含まれていた。中身は
 * ほぼすべて社内の運用メモで、顧客に見せるものではない:
 *
 *   「兄」「指定なし」「日時指定なし」「モデルルーム案件」「ヤフオク1/2」
 *   「在庫1」「在庫2」「2脚セット」「配達希望日確認中」「2/9納品確定：セット販売」
 *   **「井口へ売却」「林田様確定」「伊藤様」**（＝取引先・顧客の氏名）
 *   「指定なし：住所注意備考欄」
 *
 * 商品名はAIへ渡す一次情報なので、これらはそのまま顧客向けの商品説明へ
 * 流れ込む。**顧客の姓が公開商品ページに載り得る**経路であり、
 * 在庫数(「在庫1」)も同じ経路で漏れる。
 *
 * `【…】`の中身に商品そのものの情報が入っている例は実測では見つからず、
 * 取り除いても商品名の本体(ブランド・型番・仕様)は残る:
 *
 *   「【兄】ヤマギワ テーブルランプ Libra SS226B ブラック…」
 *     → 「ヤマギワ テーブルランプ Libra SS226B ブラック…」
 *
 * そのため一律に取り除く方針とする。
 */
export function sanitizeProductName(name: string): { name: string; removed: string[] } {
  const removed: string[] = [];
  const cleaned = name
    .replace(/【([^】]*)】/g, (_m, inner: string) => {
      removed.push(String(inner));
      return " ";
    })
    // `※…※` も同じ用途で使われている。実データで
    // `※BASE 4/5※`(出品先と社内の5段階評価)という形を確認した。
    .replace(/※([^※]{1,30})※/g, (_m, inner: string) => {
      removed.push(String(inner));
      return " ";
    })
    // 閉じ`※`が無い書き方もある(実データの `※BASE2/2 Hills Collection…`)。
    // 先頭にある場合だけ、最初の空白までを社内マーカーとして落とす ——
    // 商品名の途中にある`※`まで巻き込むと商品情報を削りかねないため。
    .replace(/^[\s　]*※\s*([^\s　]{1,20})/, (_m, inner: string) => {
      removed.push(String(inner));
      return " ";
    })
    // 取り除いた跡の余分な空白・区切りを整える。
    .replace(/[\s　]+/g, " ")
    .replace(/^[\s　・:：\-—]+/, "")
    .trim();
  return { name: cleaned, removed };
}

/**
 * 金額の記述を取り除く。
 *
 * 実測: `note` の162件中82件に「数字+円」が、34件に「定価/販売価格/税込」が
 * 含まれていた。中には `"定価42000円販売価格18000円送料込み"` のように
 * **社内の仕入・販売価格そのもの**が入っているものがある。
 *
 * 実際にこの値が生成文へそのまま出た(「定価42000円のところ、販売価格
 * 18000円（送料込み）でお求めいただけます。」)。モデルは与えられた事実に
 * 忠実だっただけで、渡していた側の問題である。価格は出品情報として別の
 * 項目で管理されるものであり、説明文中の価格が古いまま残ると実際の
 * 販売価格と食い違う。
 *
 * noteを丸ごと落とすと商品情報まで失われる(162件中82件が該当)ため、
 * 金額を含む行だけを取り除く。
 */
/**
 * 金額を含む記述かどうかの共通判定。
 *
 * 「円形」「円卓」を金額と誤認しないよう、`円` は数字が前置する場合だけ拾う。
 * 一方で実データには `販売:27800` のように **単位の無い金額** もあるため、
 * 「販売/仕入/定価/上代」+ 区切り + 数字の形も拾う。
 */
export function containsPriceMention(text: string): boolean {
  const normalized = text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (/\d[\d,]*\s*円/.test(normalized)) return true;
  // 「20万円」「3千円」のような、位取りの語を挟む書き方。
  if (/\d[\d,.]*\s*[万千]\s*円?/.test(normalized)) return true;
  if (/(定価|上代|仕入値|仕入価格|販売価格)/.test(normalized)) return true;
  // 「販売:27800」「仕入 12,000」のような、単位を伴わない書き方。
  if (/(販売|仕入|仕入れ|卸|原価)\s*[:：]?\s*\d[\d,]{2,}/.test(normalized)) return true;
  return false;
}

export function redactPriceMentions(text: string): { text: string; redacted: boolean } {
  const lines = text.split("\n");
  const kept: string[] = [];
  let redacted = false;
  for (const line of lines) {
    if (containsPriceMention(line)) {
      redacted = true;
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), redacted };
}

/**
 * Inventoryの生の行から、顧客向け生成に使ってよい事実だけを組み立てる。
 *
 * 呼び出し側(Server Action)は、この関数を通さずに生の値をAIへ渡しては
 * ならない。落とした項目はredactionsとして返るので、管理者向けの
 * デバッグ表示やログには使ってよい(顧客向けUIには出さない)。
 */
export function buildCustomerSafeFacts(input: {
  name: string;
  width?: string | null;
  depth?: string | null;
  height?: string | null;
  categoryName?: string | null;
  /** Inventory.conditionRating — 実態は社内の5段階スコア。 */
  conditionRating?: string | null;
  /** Inventory.damageNotes — 顧客へ開示すべき傷・状態の説明。 */
  damageNotes?: string | null;
  /** Inventory.note — 顧客の住所等が混ざり得るため検査してから使う。 */
  note?: string | null;
}): BuildFactsResult {
  const redactions: FactRedaction[] = [];

  const dims = [
    input.width?.trim() ? `幅${input.width.trim()}` : null,
    input.depth?.trim() ? `奥行${input.depth.trim()}` : null,
    input.height?.trim() ? `高さ${input.height.trim()}` : null,
  ].filter((v): v is string => v !== null);
  const dimensions = dims.length > 0 ? `${dims.join(" × ")}（cm）` : null;

  // コンディション: 社内スコアは落とし、damageNotesを開示文として使う。
  const rawCondition = trimmedOrNull(input.conditionRating);
  if (rawCondition && isInternalConditionScore(rawCondition)) {
    redactions.push({ field: "conditionRating", reason: "INTERNAL_SCORE" });
  }
  let conditionDisclosure = trimmedOrNull(input.damageNotes);
  // conditionRatingが数値でなく実際の説明文だった場合に限り、補助的に使う。
  if (!conditionDisclosure && rawCondition && !isInternalConditionScore(rawCondition)) {
    conditionDisclosure = rawCondition;
  }
  if (conditionDisclosure && looksLikePersonalData(conditionDisclosure)) {
    redactions.push({ field: "damageNotes", reason: "POSSIBLE_PERSONAL_DATA" });
    conditionDisclosure = null;
  }

  // note: 個人情報らしき記述があれば丸ごと落とし、そうでなければ
  // 金額の行だけを取り除く。
  let publicNote = trimmedOrNull(input.note);
  if (publicNote && looksLikePersonalData(publicNote)) {
    redactions.push({ field: "note", reason: "POSSIBLE_PERSONAL_DATA" });
    publicNote = null;
  }
  if (publicNote) {
    const { text, redacted } = redactPriceMentions(publicNote);
    if (redacted) redactions.push({ field: "note", reason: "PRICE" });
    publicNote = text || null;
  }

  // 商品名から社内マーカー(【…】)を取り除く。顧客の氏名・在庫数・
  // 納品予定などがここに入っている。
  const { name: cleanName, removed } = sanitizeProductName(input.name);
  if (removed.length > 0) {
    redactions.push({ field: "name", reason: "INTERNAL_MARKER", detail: `${removed.length}件の【】マーカーを除去` });
  }

  return {
    facts: {
      // 【】を取り除いた結果が空になる異常な名前だけは、元の名前へ戻す
      // (名前が空だと生成そのものが成立しないため)。
      name: cleanName || input.name.trim(),
      dimensions,
      categoryName: trimmedOrNull(input.categoryName),
      conditionDisclosure,
      publicNote,
    },
    redactions,
  };
}

/**
 * 事実として認めてよい文字列をひとつなぎにしたもの。
 * 生成結果の検査(factSafety.ts)が「この文章の中に根拠があるか」を
 * 判定するために使う。
 */
export function factsCorpus(facts: CustomerSafeFacts): string {
  return [facts.name, facts.dimensions, facts.categoryName, facts.conditionDisclosure, facts.publicNote]
    .filter((v): v is string => Boolean(v))
    .join("\n");
}
