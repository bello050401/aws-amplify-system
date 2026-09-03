/**
 * 商品説明の自由文から、寸法と属性を安全に取り出す(2026-09-03 追加指示 §31/§39)。
 *
 * 純粋関数のみ。外部にもDBにも触らない。
 *
 * ── なぜ要るのか ────────────────────────────────────────────────
 *
 * 実例: 在庫にサイズが入っていない商品について値下げ交渉が来た。顧客が
 * 送ってきたBASE商品ページには「W850 × D900 × H720 mm」と書いてある。
 * それでも送料が「不明」のまま通知され、値下げ判断まで進まなかった。
 * 計算に必要な数字は目の前にあったのに使っていなかった。
 *
 * ── 無理に読まない ──────────────────────────────────────────────
 *
 * 商品説明にはサイズ以外の数字がいくらでもある(価格、年式、脚の本数、
 * 「3人掛け」)。読み違えた寸法で送料ランクを出すと、実際の請求と食い違って
 * そのまま損失になる。そこで:
 *
 *   ・幅/奥行/高さの**3つとも**読めたときだけ寸法として採用する
 *   ・W/D/H や 幅/奥行/高さ のラベルが付いていれば HIGH
 *   ・「85×90×72cm」のようにラベルが無い並びは LOW(使うが要確認)
 *   ・それ以外は採用しない(推測で埋めない)
 *
 * 座面高(SH)・肘高(AH)は外形ではないので、高さとして採らない ——
 * lib/shipping/rank.ts が同じ理由で除外しているのと揃えてある。
 */

export type DimensionConfidence = "HIGH" | "LOW";

export interface ExtractedDimensions {
  /** cm。呼び出し側がそのまま lib/shipping/rank.ts へ渡せるよう文字列で返す。 */
  widthCm: string;
  depthCm: string;
  heightCm: string;
  confidence: DimensionConfidence;
  /** 元の記載(管理画面と診断ログに出す)。 */
  matchedText: string;
  /** どう読んだか。 */
  note: string;
}

/** 全角英数字・記号を半角へ。表記ゆれ(§39)をここで吸収する。 */
export function normalizeForDimensions(text: string): string {
  return (
    text
      .replace(/[Ａ-Ｚａ-ｚ０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      // 区切りの「×」は**前後に空白を入れて**半角xへ。空白が無いと
      // 「850xD900」の D が「直前が英字」に見えてしまい、
      // 座面高(SH)・肘高(AH)を除くための否定後読みに引っかかって
      // 奥行を読み落とす(実測で全角表記が丸ごと読めなかった)。
      .replace(/[×✕✖ｘＸ]/g, " x ")
      .replace(/[（）]/g, (c) => (c === "（" ? "(" : ")"))
      .replace(/[：]/g, ":")
  );
}

type Unit = "mm" | "cm" | "m";

function toCm(value: number, unit: Unit): number {
  if (unit === "mm") return value / 10;
  if (unit === "m") return value * 100;
  return value;
}

/** 数値を cm の文字列へ。小数第1位まで(それ以上は送料ランクに影響しない)。 */
function cmText(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded}cm`;
}

function detectUnit(text: string, fallback: Unit): Unit {
  const m = /(mm|cm|センチ|ミリ|(?<![a-z])m(?![a-z]))/i.exec(text);
  if (!m) return fallback;
  const found = m[1].toLowerCase();
  if (found === "mm" || found === "ミリ") return "mm";
  if (found === "cm" || found === "センチ") return "cm";
  return "m";
}

/** 妥当な家具の寸法か。桁の読み違いをここで落とす。 */
function plausible(cm: number): boolean {
  return cm >= 1 && cm <= 500;
}

/**
 * ラベル付きの寸法。
 *
 * 「W850」「幅85cm」「幅：85」。`(?<![A-Za-z])` を付けているのは、
 * SH(座面高)・AH(肘高)の H を高さとして拾わないため。
 */
const LABELLED: { axis: "width" | "depth" | "height"; re: RegExp }[] = [
  { axis: "width", re: /(?:(?<![A-Za-z])W|幅|よこ|横|間口)\s*:?\s*(?:約)?\s*(\d+(?:\.\d+)?)\s*(mm|cm|センチ|ミリ)?/i },
  { axis: "depth", re: /(?:(?<![A-Za-z])D|奥行き?|奥ゆき|たて|縦)\s*:?\s*(?:約)?\s*(\d+(?:\.\d+)?)\s*(mm|cm|センチ|ミリ)?/i },
  { axis: "height", re: /(?:(?<![A-Za-z])H|高さ|全高)\s*:?\s*(?:約)?\s*(\d+(?:\.\d+)?)\s*(mm|cm|センチ|ミリ)?/i },
];

/** ラベルの無い3連(「85x90x72cm」)。単位が書かれているものだけ拾う。 */
const BARE_TRIPLE =
  /(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*(mm|cm|センチ|ミリ)/i;

/**
 * 座面高・肘高だけが書かれた部分を落とす。
 *
 * 「SH420」「座面高42cm」が残っていると、高さのラベル検出が
 * その数値を拾ってしまう可能性がある。先に取り除く。
 */
function stripSeatHeights(text: string): string {
  return text
    .replace(/(?:座面高さ?|座高|シート高|(?<![A-Za-z])SH|(?<![A-Za-z])AH|肘高)\s*:?\s*(?:約)?\s*\d+(?:\.\d+)?\s*(?:mm|cm|センチ|ミリ)?/gi, " ")
    .replace(/(?:座面|肘掛け?|アーム)\s*[:：]?\s*(?:W|D|H)?\s*\d+(?:\.\d+)?\s*(?:mm|cm|センチ|ミリ)?/gi, " ");
}

/**
 * 商品説明から寸法を取り出す。3辺そろわなければ null。
 *
 * **1辺や2辺だけでは返さない。** 送料ランクは3辺の合計で決まるので、
 * 足りない辺を在庫側の別の値で埋めると、出所の違う数字が混ざった合計に
 * なる。そういう混ぜ方は追跡できないので行わない。
 */
export function extractDimensionsFromText(text: string | null | undefined): ExtractedDimensions | null {
  if (!text) return null;
  const normalized = stripSeatHeights(normalizeForDimensions(text));

  // ── ラベル付き ──────────────────────────────────────────────
  const found: Partial<Record<"width" | "depth" | "height", { cm: number; raw: string; unit: Unit | null }>> = {};
  for (const { axis, re } of LABELLED) {
    const m = re.exec(normalized);
    if (!m) continue;
    const value = Number(m[1]);
    if (!Number.isFinite(value)) continue;
    const unit = m[2] ? detectUnit(m[2], "cm") : null;
    found[axis] = { cm: value, raw: m[0].trim(), unit };
  }

  if (found.width && found.depth && found.height) {
    // 単位が1つも書かれていない場合の既定。
    //
    // 「W850 D900 H720」は mm と読むのが自然(cm なら 8.5m の家具になる)。
    // 逆に「W85 D90 H72」は cm。数値の大きさから決める —— 単位を勝手に
    // 決めるのではなく、**どちらに読んでも家具としてありえない方を捨てる**。
    const explicit = [found.width, found.depth, found.height].find((v) => v?.unit != null)?.unit ?? null;
    const maxValue = Math.max(found.width.cm, found.depth.cm, found.height.cm);
    const fallbackUnit: Unit = maxValue >= 500 ? "mm" : "cm";
    const axes = (["width", "depth", "height"] as const).map((axis) => {
      const entry = found[axis]!;
      return toCm(entry.cm, entry.unit ?? explicit ?? fallbackUnit);
    });
    if (axes.every(plausible)) {
      return {
        widthCm: cmText(axes[0]),
        depthCm: cmText(axes[1]),
        heightCm: cmText(axes[2]),
        confidence: "HIGH",
        matchedText: [found.width.raw, found.depth.raw, found.height.raw].join(" / "),
        note: "商品説明の幅・奥行・高さの記載から読み取りました。",
      };
    }
  }

  // ── ラベル無しの3連 ────────────────────────────────────────
  const triple = BARE_TRIPLE.exec(normalized);
  if (triple) {
    const unit = detectUnit(triple[4], "cm");
    const axes = [Number(triple[1]), Number(triple[2]), Number(triple[3])].map((v) => toCm(v, unit));
    if (axes.every((v) => Number.isFinite(v) && plausible(v))) {
      return {
        widthCm: cmText(axes[0]),
        depthCm: cmText(axes[1]),
        heightCm: cmText(axes[2]),
        // ラベルが無い以上、幅×奥行×高さの順である保証は無い。
        // 合計は同じなので送料ランクは変わらないが、個々の軸は信用しない。
        confidence: "LOW",
        matchedText: triple[0].trim(),
        note: "商品説明に幅・奥行・高さのラベルが無いため、記載順を幅×奥行×高さとして読みました。確認が必要です。",
      };
    }
  }

  return null;
}

/* ══════════════════════════════════════════════════════════════════
 * 属性(§31)
 * ══════════════════════════════════════════════════════════════════ */

export interface ExtractedAttributes {
  material: string | null;
  color: string | null;
  brand: string | null;
  modelNumber: string | null;
  weight: string | null;
  condition: string | null;
}

/**
 * 「素材：オーク材」のように**ラベルが明示されている**ものだけ拾う。
 *
 * 本文中の語から素材や色を推測しない。「ブラウンの箱で届きます」を
 * 色として拾うような読み違いは、顧客への回答に直接出るため避ける。
 */
const ATTRIBUTE_PATTERNS: { key: keyof ExtractedAttributes; re: RegExp }[] = [
  { key: "material", re: /(?:素材|材質|張地|生地)\s*[:：]\s*([^\n\r。]{1,40})/ },
  { key: "color", re: /(?:カラー|色|色味)\s*[:：]\s*([^\n\r。]{1,40})/ },
  { key: "brand", re: /(?:ブランド|メーカー|製造元)\s*[:：]\s*([^\n\r。]{1,40})/ },
  { key: "modelNumber", re: /(?:型番|品番|モデル(?:番号)?)\s*[:：]\s*([^\n\r。]{1,40})/ },
  { key: "weight", re: /(?:重量|重さ)\s*[:：]\s*([^\n\r。]{1,40})/ },
  { key: "condition", re: /(?:状態|コンディション)\s*[:：]\s*([^\n\r。]{1,60})/ },
];

export function extractAttributesFromText(text: string | null | undefined): ExtractedAttributes {
  const empty: ExtractedAttributes = {
    material: null,
    color: null,
    brand: null,
    modelNumber: null,
    weight: null,
    condition: null,
  };
  if (!text) return empty;
  const normalized = normalizeForDimensions(text);
  const out = { ...empty };
  for (const { key, re } of ATTRIBUTE_PATTERNS) {
    const m = re.exec(normalized);
    if (!m) continue;
    const value = m[1].trim().replace(/[\s　]+/g, " ");
    if (value.length > 0) out[key] = value;
  }
  return out;
}

/**
 * HTMLを含みうる商品説明を平文へ。
 *
 * BaseProductArchive.detailRaw と BASE APIの description はどちらも
 * HTMLを含みうる。タグの中の属性値(URL等)を本文として読むと、そこにある
 * 数字を寸法と誤読する。タグは中身ごと落とす。
 */
export function descriptionToPlainText(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    // タグを空白へ置き換えた結果、行頭・行末に空白が残る。寸法の抽出は
    // 空白に寛容だが、比較・表示で余計な差になるのでここで落とす。
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 商品説明に書かれている配送ランクを読み取る。
 *
 * ── なぜ寸法より優先するのか(2026-09-03 実測) ────────────────────
 *
 * BELLOのBASE商品説明には、発送方法としてランクがそのまま書かれている:
 *
 *   埼玉県より、家財おまかせ便Bランク、または、自社での配送を予定しております。
 *
 * これは**BELLOが商品ごとに決めた値**であって、寸法から推定した結果では
 * ない。寸法からの推定は、
 *
 *   - 円形スツール(座面直径34cm / 脚幅44cm / 高さ75cm)のように
 *     幅・奥行・高さの3辺で書かれていない商品では取れない
 *   - 取れても、脚の張り出しや梱包の実寸とはずれる
 *
 * ため、書いてあるならそちらを使うほうが正確で、取りこぼしも少ない。
 * 実際、HAY REVOLVER BAR STOOL は寸法抽出が null になり
 * 「想定送料：不明」になっていたが、説明文にはBランクと明記されていた。
 *
 * **推測はしない。** 「大型」「小型」のような曖昧な語からランクを起こす
 * ことはせず、ランクが明示されている場合だけ返す。
 */
export function extractShippingRankFromText(text: string | null | undefined): {
  rank: string;
  matchedText: string;
} | null {
  if (!text) return null;
  // 「家財おまかせ便Bランク」「らくらく家財便 Cランク」「Eランク」など。
  // ランク名は SS / S / A〜G。SS を先に見ないと S として読んでしまう。
  const re = /(?:家財[^。\n]{0,12}便\s*)?(SS|[A-G])\s*ランク/gi;
  let best: { rank: string; matchedText: string } | null = null;
  for (const m of text.matchAll(re)) {
    const rank = m[1].toUpperCase();
    // 最初に見つかったものを採る。説明文では発送方法の記載が1箇所なので
    // 通常1件しか当たらない。複数当たった場合に後勝ちで上書きすると、
    // 注意書き側の記述に引きずられる。
    if (!best) best = { rank, matchedText: m[0].trim() };
  }
  return best;
}
