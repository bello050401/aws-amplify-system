/**
 * 座面寸法(2026-09-04 EC出品改修指示書 §6-1)。
 *
 * ── どこに入っているのか(実データで確認) ────────────────────────
 *
 * ZAICOの `⚪︎座面寸法` / `⚪︎座面寸法(ソファ・椅子)` が、BELLOの
 * CustomField `seatDimensions` へ入る(lib/inventory/zaicoMapping.ts)。
 * Staging実測(2026-09-04、在庫5,329件): **872件**に値がある。
 *
 * 書き方は揃っていない。実際に現れた形:
 *
 *   "幅41 奥行40 高さ47"
 *   "幅130 奥行50 高さ39"
 *   "奥行40 幅45"                     ← 高さが無い / 順序が違う
 *   "幅46 奥行42 高さ43-53"           ← 範囲(昇降式)
 *   "座面幅42座面奥行42座面高さ46"     ← 区切り無し・「座面」が各軸に付く
 *   "幅59奥行60高さ43"                ← 区切り無し
 *   "高さ38"                          ← 1軸だけ
 *
 * ── 推測しない(§21) ────────────────────────────────────────────
 *
 * 取れなかった軸は**空のまま**返す。「座面高が無いから45cmくらい」と
 * 埋めることは禁止されている。範囲表記("43-53")も数値へ丸めず、
 * 書かれたまま持ち回る —— 昇降式の下限だけを載せると仕様を誤って伝える。
 *
 * このファイルはDBにも外部にも触らない純粋関数だけ。
 */
import { resolveOuterDimensionCm } from "@/lib/shipping/rank";

export interface SeatDimensions {
  /** 幅。書かれたままの文字列("41" / "43-53")。無ければ null。 */
  width: string | null;
  depth: string | null;
  height: string | null;
  /** 元の入力(監査・画面表示用)。 */
  raw: string | null;
  /** どこから取れたか。 */
  source: "SEAT_DIMENSIONS_FIELD" | "AXIS_LABELS" | "NONE";
  /** 1軸でも取れたか。 */
  hasAny: boolean;
  /** 3軸そろっているか(商品説明へ「幅×奥行×高さ」で書けるか)。 */
  hasAll: boolean;
}

export function emptySeatDimensions(): SeatDimensions {
  return { width: null, depth: null, height: null, raw: null, source: "NONE", hasAny: false, hasAll: false };
}

/**
 * 数値(範囲表記を含む)。
 *
 * 「43-53」「43〜53」を1つの値として捉える。全角数字・全角ドットは
 * 半角へ寄せてから当てる。
 */
const NUMBER = String.raw`\d+(?:\.\d+)?(?:\s*[-−~〜ー―]\s*\d+(?:\.\d+)?)?`;

function normalize(raw: string): string {
  return raw.replace(/[０-９．]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

/** 「(座面)幅41」のような、ラベル+数値を1軸ぶん取り出す。 */
function pickAxis(text: string, labels: string[]): string | null {
  for (const label of labels) {
    const m = text.match(new RegExp(`(?:座面|座)?\\s*${label}\\s*[:：]?\\s*(${NUMBER})`));
    if (m) return m[1].replace(/\s+/g, "");
  }
  return null;
}

/**
 * `customFields.seatDimensions` の文字列を軸ごとに分解する。
 *
 * 3軸そろわなくても、取れた分だけ返す —— 「座面高だけ分かっている」は
 * 実データに普通にある(スツール等)し、それでも顧客には有用な情報。
 */
export function parseSeatDimensionsText(raw: string | null | undefined): SeatDimensions {
  const text = raw?.trim();
  if (!text) return emptySeatDimensions();
  const t = normalize(text);

  const width = pickAxis(t, ["幅", "W"]);
  const depth = pickAxis(t, ["奥行き", "奥行", "D"]);
  const height = pickAxis(t, ["高さ", "高", "H", "SH"]);

  // ラベルが1つも当たらない場合、数値だけを順に並べた書き方
  // ("41 40 47")である可能性がある。**ここは推測しない** ——
  // どの数値が幅でどれが高さかを決める根拠が無い。raw だけ持って返す。
  const hasAny = Boolean(width || depth || height);
  return {
    width,
    depth,
    height,
    raw: text,
    source: hasAny ? "SEAT_DIMENSIONS_FIELD" : "NONE",
    hasAny,
    hasAll: Boolean(width && depth && height),
  };
}

/**
 * 幅/奥行/高さの自由入力文字列に紛れ込んでいる座面寸法を拾う。
 *
 * ── なぜここから取れるのか ──────────────────────────────────────
 *
 * 送料判定(lib/shipping/rank.ts)は、外形3辺を決めるときに
 * 「座面/座高/SH/AH」のラベルが付いた数値を**意図的に除外**している。
 * 除外された候補こそが座面寸法なので、その `excluded` をそのまま使う。
 * 同じ判定表を2つ持たないための再利用であって、新しいルールではない。
 *
 * 実データ例: height = "75 フットレスト高さ25.5" / width = "座面直径34"。
 */
export function seatDimensionsFromAxisText(input: {
  width?: string | null;
  depth?: string | null;
  height?: string | null;
}): SeatDimensions {
  const picked: { width: string | null; depth: string | null; height: string | null } = {
    width: null,
    depth: null,
    height: null,
  };
  const axes = [
    { key: "width" as const, raw: input.width },
    { key: "depth" as const, raw: input.depth },
    { key: "height" as const, raw: input.height },
  ];
  const rawParts: string[] = [];
  for (const axis of axes) {
    for (const ex of resolveOuterDimensionCm(axis.raw).excluded) {
      // 「座面」を含むラベルだけを採る。SH/AH/肘/内寸は座面寸法ではない
      // (SHは座面高だが、ラベル表記が多様で取り違えやすいので
      //  「座」の字が出ているものに限る —— 曖昧なら採らない)。
      if (!/座/.test(ex.label)) continue;
      const value = String(ex.valueCm);
      if (/幅|直径/.test(ex.label) && !picked.width) picked.width = value;
      else if (/奥行/.test(ex.label) && !picked.depth) picked.depth = value;
      else if (/高/.test(ex.label) && !picked.height) picked.height = value;
      rawParts.push(`${ex.label}${value}`);
    }
  }
  const hasAny = Boolean(picked.width || picked.depth || picked.height);
  return {
    ...picked,
    raw: rawParts.length > 0 ? rawParts.join(" ") : null,
    source: hasAny ? "AXIS_LABELS" : "NONE",
    hasAny,
    hasAll: Boolean(picked.width && picked.depth && picked.height),
  };
}

/**
 * 座面寸法を決める。CustomFieldを第一とし、取れなければ幅/奥行/高さの
 * 自由入力に紛れているものを拾う。
 */
export function resolveSeatDimensions(input: {
  seatDimensionsField?: string | null;
  width?: string | null;
  depth?: string | null;
  height?: string | null;
}): SeatDimensions {
  const fromField = parseSeatDimensionsText(input.seatDimensionsField);
  if (fromField.hasAny) return fromField;
  const fromAxes = seatDimensionsFromAxisText(input);
  if (fromAxes.hasAny) return fromAxes;
  // CustomFieldに値はあるがラベルを読めなかった場合、raw だけは残す
  // (画面に「登録はされているが読み取れない」と出せるように)。
  return fromField.raw ? fromField : emptySeatDimensions();
}

/**
 * 座面寸法の警告(未登録・一部欠け)を出してよい商品か(2026-09-10追加指示)。
 *
 * ── なぜ要る判定なのか ──────────────────────────────────────────
 *
 * 座面寸法の警告はこれまで**無条件**に出ていた。座面が無いのが普通の
 * 商品(デスク・テーブル・照明)にまで「⚠ 座面寸法が登録されていません」
 * が出て、実測でユーザーが指摘した(デスクの商品ページに座面不足の警告)。
 * 座面のある商品(チェア・ソファ・スツール等)に限定する。
 *
 * ── カテゴリは「商品種別を示しているときだけ」優先する(レビュー対応) ──
 *
 * BELLOの `categoryName` の実データは「販売中」「撮影待ち」「川越移動
 * 予定,五十嵐さん」のような**業務区分**であって、商品種別ではないことが
 * 多い。以前の実装は「カテゴリがあれば商品名を一切見ない」だったため、
 * こうした業務区分が付いているだけで椅子の座面警告まで消えてしまって
 * いた(椅子でも `categoryName` は「販売中」等になりうる)。
 *
 * 直すのは「カテゴリを信用する条件」であって、優先順位そのものではない
 * —— カテゴリが座面を要求する語・除外する語のどちらかに実際に一致した
 * ときだけそのカテゴリで確定し、商品名は見ない(「デスク」カテゴリの
 * 商品名に「チェア」が混ざっていても対象外、は従来どおり維持)。
 * カテゴリがどちらにも一致しない(=商品種別を示していない業務区分)なら、
 * 商品名で判定する。
 *
 * 商品名の「チェア」等の語だけを無条件の根拠にしない —— 「チェアサイド
 * テーブル」のような名前を持つテーブルを椅子と誤判定しうる。机・テーブル
 * ・照明を示す語が先にあれば、座面を示す語が同居していても対象外を
 * 優先する。商品名の末尾に付く「関連:チェア」のような検索参考語(実際の
 * 商品種別ではない)は判定材料から外す。
 */
const SEAT_REQUIRING_WORDS = /チェア|椅子|(?<!ア)イス|ソファ|スツール|オットマン|ベンチ/;
const SEAT_EXCLUDED_WORDS = /テーブル|デスク|机|照明|ランプ|シェルフ|キャビネット|収納|ミラー|ラグ|ワゴン|ベッド|棚/;

/**
 * 商品名の末尾に付く検索参考語(「関連:チェア」「関連：デスク,チェア」等)
 * を判定対象から除く。実データにある付与形式で、類似商品の検索用に
 * 付いているだけであり、その商品自体の種別ではない。
 */
function stripSearchReferenceHints(name: string): string {
  return name.replace(/関連[:：][\s\S]*$/, "").trim();
}

export function requiresSeatDimensions(input: { categoryName?: string | null; name?: string | null }): boolean {
  const category = input.categoryName?.trim();
  if (category) {
    // カテゴリが実際に商品種別(座面の要否)を示しているときだけ、
    // カテゴリだけで決める。商品名は見ない
    // (「デスク」カテゴリの商品名に「チェア」が混ざっていても対象外)。
    if (SEAT_EXCLUDED_WORDS.test(category)) return false;
    if (SEAT_REQUIRING_WORDS.test(category)) return true;
    // ここに来るのは「販売中」「撮影待ち」のような業務区分 ——
    // 商品種別を示していないので、商品名で判定する(下へフォールスルー)。
  }
  const name = input.name?.trim();
  if (!name) return false;
  const searchableName = stripSearchReferenceHints(name);
  if (!searchableName) return false;
  // 机/テーブル/照明を示す語があれば、座面を示す語が同居していても
  // 対象外を優先する。
  if (SEAT_EXCLUDED_WORDS.test(searchableName)) return false;
  return SEAT_REQUIRING_WORDS.test(searchableName);
}

/**
 * 商品説明へ書く1行(§6-1)。「座面寸法:幅46×奥行41×高さ46.5cm」。
 *
 * 取れなかった軸は書かない。3軸そろっていなければ、そろっている分だけを
 * 同じ形式で並べる —— 欠けた軸を「-」で埋めると、測っていないのか
 * 存在しないのかが読めない。
 */
export function formatSeatDimensionsLine(seat: SeatDimensions): string | null {
  const parts = [
    seat.width ? `幅${seat.width}` : null,
    seat.depth ? `奥行${seat.depth}` : null,
    seat.height ? `高さ${seat.height}` : null,
  ].filter((v): v is string => v !== null);
  if (parts.length === 0) return null;
  return `座面寸法:${parts.join("×")}cm`;
}
