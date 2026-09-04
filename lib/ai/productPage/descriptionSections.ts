/**
 * 商品説明のルールベース領域(2026-09-04 EC出品改修指示書 §6-§19)。
 *
 * ── なぜAIに書かせないのか ──────────────────────────────────────
 *
 * §19/§28。寸法・座面寸法・配送ランク・メンテナンス実施内容・傷汚れ・
 * 返品条件・お取り置き条件は、**確定データか計算で決まる**。決まるものを
 * 言語モデルに書かせると、
 *
 *   ・座面高が無い商品に「座面高約45cm」と書く
 *   ・コーティング記録が無い商品に「コーティング済み」と書く
 *   ・サイズ感から「家財おまかせ便Cランク」と当て推量する
 *
 * が起きる。実際にどれも起きうる形で運用されていた。だからここは
 * 純粋関数として切り出し、AIは「◎商品のご紹介」だけを担当する。
 *
 * このファイルはDBにも外部にも触らない。scripts/verify-listing-description.ts
 * が全分岐を固定する。
 */
import type { SeatDimensions } from "@/lib/inventory/seatDimensions";
import { formatSeatDimensionsLine } from "@/lib/inventory/seatDimensions";
import type { MaintenanceResult } from "@/lib/inventory/maintenance";
import { normalizeConditionDisclosure } from "@/lib/inventory/conditionPhrasing";
import type { ShippingRank } from "@/lib/shipping/rank";

/* ══════════════════════════════════════════════════════════════════
 * §16-§18 全商品共通の固定文。AI判断で削除させない。
 * ══════════════════════════════════════════════════════════════════ */

/** §16 全商品共通の注意事項。◎コンディションの末尾に置く(§27の実例に合わせる)。 */
export const COMMON_NOTICES = [
  "※リユース品の特性上、細かな見落としがある場合がございます。予めご了承ください。",
  "※リユース品の特性や輸送・保管の過程により、微細なスレ等が生じる場合がございます。",
  "お写真にない明らかな破損や傷があった場合は、輸送中のトラブルの可能性もございますので、必ず受取評価前にご相談ください。",
  "※電球色の照明環境下にて、実物との差異が生じないよう慎重に撮影しております。",
  "※保管状況により梱包済みの場合が多く、追加の撮影が難しい場合がございます。あらかじめご了承ください。",
].join("\n");

/** §15 メンテナンス・状態の説明のあとに置く共通文。 */
export const CONDITION_CLOSING = [
  "当ショップでは、仕入れ後に一点ずつ状態を確認し、丁寧にメンテナンス・清掃を行っております。",
  "リユース品でありながら、モデルルーム展示品に近い清潔感を目指し、安心してお使いいただける状態に整えております。",
  "他店とは異なる品質管理でご提供しておりますので、どうぞご安心くださいませ。",
].join("\n");

/** §17 返品・返金対応について。 */
export const RETURN_POLICY_BODY = [
  "商品到着後、状態にご納得いただけない場合は、評価前に理由を添えてご連絡ください。誠心誠意対応いたします。",
  "リユース品のため一点物が多く、交換が難しい場合は返品・返金での対応となります。",
  "また、ご購入金額を超える返金はできかねますのでご了承ください。",
  "※事前確認可能事項は返品対象外となります（例：搬入不可、イメージと異なる等）",
  "特に大型商品（目安：180cm以上）については、ご購入前に搬入経路（通路幅・階段・エレベーター等）を必ずご確認ください。",
  "※搬入不可が原因と当方が判断した場合は、他の理由を含めたキャンセル・返品はお受けできませんのでご了承ください。",
].join("\n");

/** §18 お取り置きについて。 */
export const HOLD_POLICY_BODY = [
  "入金前のお取り置きは対応しておりません。",
  "購入後は原則として2週間以内の発送をお願いしております。",
  "それ以上の保管をご希望の場合は、事前にご相談ください。",
].join("\n");

/** §7 遠方地域の案内。配送方法が確定しなくても必ず出す。 */
const REMOTE_AREA_NOTICE = [
  "＜九州・沖縄・北海道・離島への発送をご希望の方へ＞",
  "送料が高額になるため、お手数ですが購入前に1度ご相談いただきますようお願いいたします。",
].join("\n");

/**
 * §10 配送方法を判定できないときに本文へ入れる印。
 *
 * 空欄にはしない。**担当者が見つけられる形**で残す ——
 * 商品説明はそのままECへ送られるので、確定していないことが読み取れないと
 * 誤った案内のまま公開されうる。
 */
export const SHIPPING_UNDETERMINED_MARKER = "【配送方法未確定：要確認】";

/* ══════════════════════════════════════════════════════════════════
 * §6 ◎商品詳細
 * ══════════════════════════════════════════════════════════════════ */

export interface ProductDetailInput {
  /** ZAICO由来の寸法(自由入力の文字列そのまま)。 */
  width: string | null;
  depth: string | null;
  height: string | null;
  /** 全長(該当商品のみ)。 */
  overallLength?: string | null;
  seat: SeatDimensions;
}

/** 「46cm」の形へ。既に単位が付いていれば足さない(実データに "46cm" もある)。 */
function withCm(value: string): string {
  const v = value.trim();
  return /cm|ｃｍ|mm|ミリ|センチ/i.test(v) ? v : `${v}cm`;
}

/**
 * §6 ◎商品詳細。**ZAICOに存在する実データだけ**を並べる。
 *
 * AIに整形させない —— 「幅46cm」を「およそ46センチ」と書き換えられると、
 * 元の値と表示が一致しなくなる。取れなかった軸は行ごと出さない。
 */
export function buildProductDetailSection(input: ProductDetailInput): string {
  const lines: string[] = [];
  if (input.width?.trim()) lines.push(`幅:${withCm(input.width)}`);
  if (input.depth?.trim()) lines.push(`奥行:${withCm(input.depth)}`);
  if (input.height?.trim()) lines.push(`高さ:${withCm(input.height)}`);
  if (input.overallLength?.trim()) lines.push(`全長:${withCm(input.overallLength)}`);
  const seatLine = formatSeatDimensionsLine(input.seat);
  if (seatLine) lines.push(seatLine);
  return lines.join("\n");
}

/* ══════════════════════════════════════════════════════════════════
 * §7/§8 ◎発送について
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 家財便のサービス名称(2026-09-04 追加指示 §1)。
 *
 * 顧客向けの表記は利用者の指定どおり「らくらく家財便」。
 * 社内の設定画面・送料見積りは「家財おまかせ便(アートセッティング
 * デリバリー)」という呼称のままだが、指すサービスは同じ。
 * 顧客が目にする文面を1箇所で決められるよう、ここを唯一の出所にする。
 */
export const KAZAI_SERVICE_NAME = "らくらく家財便";

export interface ShippingSectionInput {
  /**
   * 担当者が選んだ配送方法(§1)。**サイズから自動で切り替えない。**
   * 未指定は既定の家財便として扱う。
   */
  method?: "KAZAI" | "SAGAWA";
  /** らくらく家財便のランク。判定できなければ null(§10)。 */
  rank: ShippingRank | null;
  /** 佐川急便のサイズ区分表記(「佐川急便160サイズ」)。判定できなければ null。 */
  sagawaSizeLabel?: string | null;
  /** 判定できなかった理由(担当者向け)。 */
  unresolvedReason?: string | null;
}

/**
 * §7/§1 ◎発送について。
 *
 * 選ばれた配送方法に応じて、差し込む文言だけを切り替える。
 *
 *   KAZAI  → 「らくらく家財便Cランク」(既存の rank.ts の判定結果)
 *   SAGAWA → 「佐川急便160サイズ」(3辺合計+20cmの判定結果)
 *
 * どちらも決まっていなければ**推測しない**(§10) —— 印を残して人へ回す。
 *
 * 家財便の OVERSIZE(規格外候補)はランク表の範囲外なので、ランク名を
 * 書かない。「Gランクの上」ではなく「個別見積り」であって、書くと誤案内。
 */
export function buildShippingSection(input: ShippingSectionInput): string {
  const method =
    (input.method ?? "KAZAI") === "SAGAWA"
      ? (input.sagawaSizeLabel ?? SHIPPING_UNDETERMINED_MARKER)
      : input.rank && input.rank !== "OVERSIZE"
        ? `${KAZAI_SERVICE_NAME}${input.rank}ランク`
        : SHIPPING_UNDETERMINED_MARKER;
  return [`埼玉県より、${method}、または、自社での配送を予定しております。`, REMOTE_AREA_NOTICE].join("\n");
}

/* ══════════════════════════════════════════════════════════════════
 * §11-§15 ◎コンディション
 * ══════════════════════════════════════════════════════════════════ */

/** §12 リンサー施工商品の文章。 */
export const RINSER_SENTENCE =
  "ファブリック部分は、薬剤師監修のもと調合した洗剤を使用し、素材に応じて温度・濃度を調整しながら丁寧にクリーニングを行っております。";

/** §13 研磨のみ。 */
export const POLISH_SENTENCE = "当店にて表面を丁寧に研磨したうえで、仕上げを施しております。";

/** §13 研磨 + コーティング。 */
export const POLISH_COATING_SENTENCE = "当店にて表面を丁寧に研磨したうえで、仕上げにコーティングを施しております。";

/** コーティングのみ(研磨の記録が無い)。研磨したとは書かない。 */
export const COATING_ONLY_SENTENCE = "当店にて表面にコーティングを施しております。";

/** クリーニングのみ。リンサー(ファブリック洗浄)とは別。 */
export const CLEANING_SENTENCE = "当店にて丁寧にクリーニングを行っております。";

/** §14 状態が良好であることが確認できる場合の文章。 */
export const GOOD_CONDITION_SENTENCE = "目立つ傷や汚れは見受けられず、全体として良好なコンディションです。";

export interface ConditionSectionInput {
  maintenance: MaintenanceResult;
  /** ファブリックが明らかに無い商品か(§12 矛盾する文章を使わない)。 */
  nonFabric: boolean;
  /**
   * 顧客へ開示する状態の説明(damageNotes 由来、個人情報・金額を除去済み)。
   * **ここに書かれていることを無視して「良好」と書かない**(§14)。
   */
  conditionDisclosure: string | null;
  /**
   * 「良好」と書いてよい根拠があるか。
   *
   * 呼び出し側が社内のコンディション評価(5段階)から決める。無ければ
   * false —— 傷の記録が無いことは、状態が良い証拠ではない。
   */
  goodConditionEvidence: boolean;
}

export interface ConditionSectionResult {
  text: string;
  /** 担当者へ出す警告(§21)。 */
  warnings: string[];
  /** どの文をどの根拠で入れたか(監査用)。 */
  notes: string[];
}

/**
 * メンテナンス由来の文章(§12/§13)。
 *
 * 研磨とコーティングは1文にまとめる —— 「研磨しました。コーティングも
 * しました。」は不自然で、§13が示す文例も1文になっている。
 */
function maintenanceSentences(input: ConditionSectionInput): { sentences: string[]; notes: string[]; warnings: string[] } {
  const m = input.maintenance;
  const sentences: string[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];

  if (m.polish && m.coating) {
    sentences.push(POLISH_COATING_SENTENCE);
    notes.push("研磨とコーティングの記録があるため、両方に触れる文章を使いました。");
  } else if (m.polish) {
    sentences.push(POLISH_SENTENCE);
    notes.push("研磨の記録があるため、研磨の文章を使いました（コーティングの記録は無いので触れていません）。");
  } else if (m.coating) {
    sentences.push(COATING_ONLY_SENTENCE);
    notes.push("コーティングの記録のみがあるため、研磨には触れていません。");
  }

  if (m.rinser) {
    if (input.nonFabric) {
      // §12 明らかに矛盾する場合は使わない。黙って落とさず理由を残す。
      warnings.push(
        "リンサー施工の記録がありますが、材質からファブリック部分が無いと判断したため、ファブリック洗浄の文章は入れていません。",
      );
    } else {
      sentences.push(RINSER_SENTENCE);
      notes.push("リンサー施工の記録があるため、ファブリック洗浄の文章を使いました。");
    }
  } else if (m.cleaning) {
    // リンサーの文章とクリーニングの文章を両方入れると同じことを2回言う。
    sentences.push(CLEANING_SENTENCE);
    notes.push("クリーニングの記録があるため、クリーニングの文章を使いました。");
  }

  return { sentences, notes, warnings };
}

/**
 * §11-§15 ◎コンディション。
 *
 * 並びは「メンテナンス内容 → 状態 → 共通文 → 共通注意事項」。
 * §27の実例と同じ順序にしてある。
 */
export function buildConditionSection(input: ConditionSectionInput): ConditionSectionResult {
  const { sentences, notes, warnings } = maintenanceSentences(input);
  const paragraphs: string[] = [];

  if (sentences.length > 0) paragraphs.push(sentences.join("\n"));

  // ── 状態の文(§14) ────────────────────────────────────────
  //
  // **登録されている傷・汚れを無視して「良好」と書かない。**
  // 記録があるならそれを出し、無い場合は「良好」と書ける根拠があるとき
  // だけ良好の文を使う。どちらも無ければ状態については書かない ——
  // 書かないほうが、根拠の無い「良好」より正確。
  //
  // §5 社内向けの短い断片(「小傷あり」)はそのまま出さず、事実を変えない
  // 範囲で文章へ整える。場所・程度・影響は足さない(normalizeConditionDisclosure)。
  const normalized = normalizeConditionDisclosure(input.conditionDisclosure);
  const disclosure = normalized?.text ?? null;
  if (disclosure) {
    paragraphs.push(disclosure);
    notes.push(
      normalized?.rewritten
        ? "状態の説明は在庫の「傷汚れ箇所等メモ」を、事実を変えずに文章へ整えて使いました。"
        : "状態の説明は在庫の「傷汚れ箇所等メモ」をそのまま使いました。",
    );
    if (normalized?.hasDamage) notes.push("傷・汚れ等があるため、お写真の確認をご案内する一文を添えました。");
    if (input.goodConditionEvidence) {
      notes.push("社内評価は良好ですが、傷・汚れの記録があるため「良好」の定型文は使っていません。");
    }
  } else if (input.goodConditionEvidence) {
    paragraphs.push(GOOD_CONDITION_SENTENCE);
    notes.push("傷・汚れの記録が無く、社内のコンディション評価が良好のため、良好の文章を使いました。");
  } else {
    warnings.push(
      "コンディションの情報（傷汚れ箇所等メモ・コンディション評価）が登録されていないため、状態についての文章を入れていません。",
    );
  }

  if (!input.maintenance.hasAny) {
    warnings.push("メンテナンスの記録が見つからなかったため、メンテナンス内容の文章を入れていません。");
  }

  // §15 共通文。§16 共通注意事項。どちらもAI判断で削らせない。
  paragraphs.push(CONDITION_CLOSING);
  paragraphs.push(COMMON_NOTICES);

  return { text: paragraphs.join("\n\n"), warnings, notes };
}

/* ══════════════════════════════════════════════════════════════════
 * §4 商品説明全体の組み立て
 * ══════════════════════════════════════════════════════════════════ */

export interface ComposeListingDescriptionInput {
  /** ◎商品のご紹介(AI生成)。空なら見出しごと出さない。 */
  introduction: string | null;
  /** ◎商品詳細(ルール)。 */
  productDetail: string;
  /** ◎発送について(ルール)。 */
  shipping: string;
  /** ◎コンディション(ルール)。 */
  condition: string;
}

/**
 * §4 の基本フォーマットへ組み立てる。
 *
 * 見出しと並びは指示書のとおり固定。中身が空のセクションは見出しごと
 * 出さない —— 「◎商品詳細」とだけ書かれた空欄は、情報が無いことを
 * 伝えるどころか書き忘れに見える(既存の composeFullDescription と同じ方針)。
 *
 * ただし ◎返品・返金対応について / ◎お取り置きについて は常に出す
 * (§17/§18 全商品共通)。
 */
export function composeListingDescription(input: ComposeListingDescriptionInput): string {
  const parts: { heading: string; body: string }[] = [
    { heading: "◎商品のご紹介", body: input.introduction ?? "" },
    { heading: "◎商品詳細", body: input.productDetail },
    { heading: "◎発送について", body: input.shipping },
    { heading: "◎コンディション", body: input.condition },
    { heading: "◎返品・返金対応について", body: RETURN_POLICY_BODY },
    { heading: "◎お取り置きについて", body: HOLD_POLICY_BODY },
  ];
  return parts
    .filter((p) => p.body && p.body.trim())
    .map((p) => `${p.heading}\n${p.body.trim()}`)
    .join("\n\n");
}
