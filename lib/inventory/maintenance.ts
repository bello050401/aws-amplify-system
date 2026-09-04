/**
 * メンテナンス実施内容の判定(2026-09-04 EC出品改修指示書 §11-§13)。
 *
 * ── どこに記録されているのか(実データで数えた) ────────────────────
 *
 * ZAICOにもBELLOにも「メンテナンス」という専用項目は無い。実際の記録は
 * 複数の自由入力欄へ散っている。Staging実測(2026-09-04、在庫5,329件):
 *
 *              damageNotes  note  listingNotes  name  conditionRating
 *   リンサー        71        23        6         0         0
 *   研磨            67        50       43         4         3
 *   コーティング     7        14       11         0         0
 *   クリーニング     2        14      200         4         0
 *   プロ仕上げ       0         1       50       118         0
 *
 * `damageNotes` には「リンサー」の一語だけが入っていることが多く(実例:
 * `damageNotes = "リンサー"`)、`note` には社内メモとして工程が書かれて
 * いる(実例: `"天板は研磨をして、オイル塗装を施しております。"`)。
 *
 * ── なぜ専用フィールドを作らないのか ────────────────────────────
 *
 * §0「推測だけで新しいデータ構造を作らず」。記録はZAICO側の運用で既に
 * 存在しており、BELLOに新しい欄を足しても**ZAICOから同期されない**ので
 * 空のまま残る。既存の欄を読む側で判定する。
 *
 * ── 無いものを「有る」にしない(§13/§21) ──────────────────────────
 *
 * 「コーティング」の記録が無い商品に「コーティング済み」と書くことは
 * 明示的に禁止されている。ここは**語が実際に出現したときだけ**true に
 * する。否定形(「研磨無し」「コーティングなし」)は false にする ——
 * 実データに `note = "研磨、塗装無し"` があり、素朴な部分一致だと
 * 「研磨済み」と読んでしまう。
 *
 * このファイルはDBにも外部にも触らない純粋関数だけ。
 */

/** 判定するメンテナンスの種類。 */
export type MaintenanceKind = "RINSER" | "POLISH" | "COATING" | "CLEANING";

export const MAINTENANCE_LABEL: Record<MaintenanceKind, string> = {
  RINSER: "リンサー(ファブリック洗浄)",
  POLISH: "研磨",
  COATING: "コーティング",
  CLEANING: "クリーニング",
};

export interface MaintenanceEvidence {
  kind: MaintenanceKind;
  /** どの項目に書かれていたか(監査・画面表示用)。 */
  field: string;
  /** 実際に一致した記述(前後を少し含む)。 */
  matched: string;
}

export interface MaintenanceResult {
  rinser: boolean;
  polish: boolean;
  coating: boolean;
  cleaning: boolean;
  /** 何を根拠に true にしたか。UIに出して人が確かめられるようにする。 */
  evidence: MaintenanceEvidence[];
  /** 1つでも検出したか。 */
  hasAny: boolean;
}

export function emptyMaintenance(): MaintenanceResult {
  return { rinser: false, polish: false, coating: false, cleaning: false, evidence: [], hasAny: false };
}

/**
 * 種類ごとの手がかり。
 *
 * `プロ仕上げ` を研磨と同一視しない —— 商品名に118件あるが、何をしたかは
 * その語からは決まらない(布のクリーニングかもしれない)。§13が求めて
 * いるのは「研磨を行っている場合」なので、研磨と読める語だけを採る。
 */
const PATTERNS: { kind: MaintenanceKind; pattern: RegExp }[] = [
  { kind: "RINSER", pattern: /リンサー|リンサ(?!ー)/ },
  { kind: "POLISH", pattern: /研磨|ポリッシュ|バフ掛け|バフがけ/ },
  { kind: "COATING", pattern: /コーティング|コート仕上げ|ガラスコート/ },
  { kind: "CLEANING", pattern: /クリーニング|洗浄|しみ抜き|シミ抜き/ },
];

/**
 * 否定表現。
 *
 * 実データ: `note = "研磨、塗装無し"` / `"研磨なし"`。一致した語の
 * **直後**に否定語が来る形だけを見る —— 文全体を見ると、別の話題の
 * 「無し」まで拾って実施済みの記録を打ち消してしまう。
 */
const NEGATION = /^\s*[、,]?\s*(?:[^\n。]{0,6}?)?(?:無し|なし|不可|していません|しておりません|未実施|不要)/;

/** 予定・依頼であって実施記録ではない書き方(「研磨予定」「研磨したい」)。 */
const NOT_YET = /^\s*(?:予定|する予定|したい|お願い|依頼|検討)/;

function scanField(field: string, text: string | null | undefined, out: MaintenanceEvidence[]): void {
  if (!text) return;
  for (const { kind, pattern } of PATTERNS) {
    // 同じ語が複数回出ることがあるので、すべての出現を見る。
    // 1つでも「否定でも予定でもない」出現があれば実施記録として扱う。
    const re = new RegExp(pattern.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const after = text.slice(m.index + m[0].length);
      if (NEGATION.test(after) || NOT_YET.test(after)) continue;
      const start = Math.max(0, m.index - 12);
      out.push({
        kind,
        field,
        matched: text.slice(start, m.index + m[0].length + 18).replace(/\s+/g, " ").trim(),
      });
      break;
    }
  }
}

/**
 * 在庫の各項目から、実施済みのメンテナンスを判定する。
 *
 * 見る項目は実測で記録が見つかったものだけ。商品名も見る ——
 * 「プロ仕上げ」は採らないが、`研磨` が名前に入る商品が4件ある。
 */
export function detectMaintenance(input: {
  name?: string | null;
  damageNotes?: string | null;
  note?: string | null;
  listingNotes?: string | null;
  conditionRating?: string | null;
  adminMemo?: string | null;
}): MaintenanceResult {
  const evidence: MaintenanceEvidence[] = [];
  scanField("傷汚れ箇所等メモ", input.damageNotes, evidence);
  scanField("備考", input.note, evidence);
  scanField("出品情報", input.listingNotes, evidence);
  scanField("コンディション評価", input.conditionRating, evidence);
  scanField("商品名", input.name, evidence);
  // 市川メモは社内向けだが、工程の記録が入ることがある。判定にだけ使い、
  // 中身を顧客向けの文章へ写すことはしない(このモジュールは真偽しか返さない)。
  scanField("市川メモ", input.adminMemo, evidence);

  const has = (kind: MaintenanceKind) => evidence.some((e) => e.kind === kind);
  const result: MaintenanceResult = {
    rinser: has("RINSER"),
    polish: has("POLISH"),
    coating: has("COATING"),
    cleaning: has("CLEANING"),
    evidence,
    hasAny: evidence.length > 0,
  };
  return result;
}

/**
 * 傷汚れメモから、**メンテナンスの記録だけの行**を取り除く。
 *
 * ── なぜ必要か(実データで踏んだ) ────────────────────────────────
 *
 * `damageNotes` はZAICOの「⚪︎傷汚れ箇所等メモ」だが、実際には
 * メンテナンスの記録がそこに書かれている。実測(2026-09-04):
 *
 *   damageNotes = "リンサー"                    ← 71件
 *   damageNotes = "リンサー\n一部小傷・使用感あり"
 *
 * この欄は顧客向けの状態説明として使っている(lib/ai/productIntro/
 * facts.ts)。前者をそのまま出すと、商品説明の◎コンディションに
 * **「リンサー」という社内語がぽつんと現れる**。実際に生成結果で確認した。
 *
 * さらに悪いことに、「傷の記録がある」と誤って判定されるため、
 * 実際には傷が無い商品で「良好なコンディションです」を出せなくなる。
 *
 * メンテナンスの記録は §11-§13 の文章として別に扱うので、ここでは
 * **状態説明として残らない行だけを落とす**。傷の記述が1文字でも
 * 混ざっている行は残す —— 迷ったら残す側に倒す(開示を減らさない)。
 */
export function stripMaintenanceOnlyLines(text: string | null | undefined): string | null {
  const raw = text?.trim();
  if (!raw) return null;
  const kept = raw
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      // メンテナンスの語と、区切り・済/実施のような付随語だけを取り除いて
      // 何も残らない行は、状態の説明ではない。
      const residue = t
        .replace(/リンサー|リンサ|研磨|ポリッシュ|バフ掛け|バフがけ|コーティング|コート仕上げ|ガラスコート|クリーニング|洗浄|しみ抜き|シミ抜き/g, "")
        .replace(/[済み実施あり有り施工加工処理、,。・\/／\s　()（）]/g, "");
      return residue.length > 0;
    })
    .join("\n")
    .trim();
  return kept || null;
}

/**
 * ファブリック部分がありそうな商品か(§12)。
 *
 * リンサーはファブリックの洗浄なので、ガラスや金属だけの商品に
 * 「ファブリック部分は…クリーニングを行っております」と書くと明らかに
 * 矛盾する。**否定側だけを判定する** —— 「ファブリックがあると断定」は
 * せず、「明らかに無い」ときだけ false にする。
 *
 * 判断材料が無ければ false(=文章を使う)。リンサーの記録がある時点で、
 * 実際にファブリックがあった可能性のほうがはるかに高い。
 *
 * ── 除外する材質を絞った理由(実データ) ──────────────────────────
 *
 * ZAICOの「⚪︎材質」は**主要な材質を1語**で書く欄で(実測228件:
 * "ガラス" "木材" "プリント" …)、その商品に使われている材質を網羅する
 * ものではない。木・スチール・アルミの椅子に布張りの座面が付くのは
 * この在庫では普通で、それらを理由にファブリック洗浄の文章を落とすと
 * **実際にリンサーを掛けた商品でその事実が消える**。
 *
 * そこで、天板や什器そのものがその材質で、布張り部分が同居しないものだけを
 * 挙げる。フレーム材になりうるもの(木・金属・樹脂)は挙げない。
 */
export function looksNonFabric(input: { name?: string | null; material?: string | null; categoryName?: string | null }): boolean {
  const material = (input.material ?? "").trim();
  if (!material) return false;
  const FABRIC = /ファブリック|布|レザー|革|ベロア|ベルベット|モケット|クロス|張地|シート|ウール|コットン|リネン/;
  const HARD_ONLY = /^(ガラス|大理石|石|セラミック|陶器|プリント|紙)$/;
  if (FABRIC.test(material)) return false;
  return HARD_ONLY.test(material);
}
