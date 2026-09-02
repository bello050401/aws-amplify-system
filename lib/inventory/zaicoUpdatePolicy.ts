/**
 * ZAICO同期の「項目ごとの更新の優先順位」(2026-09-02 利用者指示)。
 *
 * 純粋関数のみ。DBにも外部にも触らないので、実データの断片で回帰にかけられる。
 *
 * ══════════════════════════════════════════════════════════════════
 * なぜこれが要るのか — 実測で確認した事故
 * ══════════════════════════════════════════════════════════════════
 *
 * Staging の InventoryHistory に、**人の判断が同期に差し戻された記録**が
 * 実際に残っていた:
 *
 *   2026-08-30T12:48 [人]   inv=3026f919 "発送完了" → "補修待ち"
 *   2026-08-30T13:30 [同期] inv=3026f919           → "発送完了（ZAICO同期）"   ← 42分後
 *   2026-08-30T13:56 [人]   inv=9793e4e5 "発送完了" → "補修待ち"
 *   2026-08-30T20:38 [同期] inv=9793e4e5           → "発送完了（ZAICO同期）"
 *
 * 販売予定価格も、人が入れた2件がZAICO側と食い違っている:
 *
 *   B005610  BELLO 28,000(人が入力)  vs  ZAICO 24,800
 *   B005413  BELLO 30,004(人が入力)  vs  ZAICO 34,800
 *
 * 追加項目でも、人が座面寸法を消した履歴があるのに現在値には戻っている。
 *
 * つまり「全項目ZAICOが常に勝つ」という現行の規則が、業務の判断を
 * 静かに巻き戻していた。
 *
 * ══════════════════════════════════════════════════════════════════
 * どう判定するか — 3-way merge
 * ══════════════════════════════════════════════════════════════════
 *
 * 「人が編集したかどうか」を、編集画面側にフラグを立てさせる方式は採らない。
 * 編集経路が増えるたびに1つ書き忘れ、書き忘れた経路の編集が黙って
 * 上書きされる —— いま直そうとしている不具合と同じ形になる。
 *
 * 代わりに、**前回ZAICOが渡してきた値**を各項目について覚えておき、
 * 3つを突き合わせる:
 *
 *   lastZaico … 前回の同期でZAICOが渡した値
 *   bello     … いまBELLOに入っている値
 *   zaico     … 今回ZAICOが渡してきた値
 *
 *   bello === lastZaico  → 誰も触っていない  → ZAICOの新しい値を入れてよい
 *   bello !== lastZaico  → 人が変えた        → BELLOを残す(方針による)
 *
 * この方式なら、アプリの編集画面でも、一括編集でも、CSV取り込みでも、
 * 将来の別経路でも、**人が変えた事実そのもの**を検出できる。
 *
 * 初回(スナップショット未取得)は「誰が入れた値か分からない」状態なので、
 * 保護対象の項目は上書きせず、スナップショットだけを記録する。
 * 分からないときに人の入力を消さない側へ倒す。
 */

/** 項目ごとの更新規則。利用者の指示にある4分類に1対1で対応する。 */
export type ZaicoFieldPolicy =
  /** ZAICO常時優先。ZAICOが値を持っていれば常に上書きする。 */
  | "ZAICO_ALWAYS"
  /** BELLO／人間入力優先。人が変えていれば上書きしない(3-way merge)。 */
  | "HUMAN_WINS"
  /** BELLOが空欄の場合のみZAICOで補完する。 */
  | "FILL_IF_EMPTY"
  /** 個別判断が必要。自動では触らず、差分を人へ提示する。 */
  | "MANUAL_REVIEW";

export interface ZaicoFieldRule {
  /** BELLO側のフィールド名(Inventoryの列名、または customFields のキー)。 */
  field: string;
  /** 画面に出す日本語名。 */
  label: string;
  policy: ZaicoFieldPolicy;
  /** なぜその方針にしたか。監査表とレビューのために必ず書く。 */
  reason: string;
}

/**
 * 項目別の方針表。
 *
 * ここに無い項目は DEFAULT_POLICY(ZAICO_ALWAYS)になる —— ZAICOが正本の
 * 台帳項目が大半で、そちらを既定にするほうが表が短く、例外が目立つ。
 */
export const ZAICO_FIELD_RULES: ZaicoFieldRule[] = [
  // ── 人間優先(3-way merge) ────────────────────────────────────
  {
    field: "categoryId",
    label: "カテゴリ",
    policy: "HUMAN_WINS",
    reason:
      "BELLOのカテゴリは業務ステータス(販売中/発送完了/補修待ち/出品待ち等)として使われている。" +
      "人が「発送完了→補修待ち」へ戻した判断を同期が差し戻した実例が2件あり、実害が確認済み。",
  },
  {
    field: "customFields",
    label: "追加項目",
    policy: "HUMAN_WINS",
    reason:
      "人が座面寸法を削除した履歴があるのに現在値には戻っている。キー単位で突き合わせ、" +
      "人が消したキーをZAICOが復活させないようにする。",
  },
  {
    field: "adminMemo",
    label: "管理メモ(市川メモ)",
    policy: "HUMAN_WINS",
    reason: "BELLO担当者の自由記述。従来から createOnly として保護されており、その意図をこの表でも明示する。",
  },

  // ── BELLOが空欄のときのみ補完 ────────────────────────────────
  {
    field: "plannedSalePrice",
    label: "販売予定価格",
    policy: "FILL_IF_EMPTY",
    reason:
      "ZAICO側の項目名は「☆販売予定価格（送料別大原記載）」でZAICOが起点だが、" +
      "BELLOで人が調整した値が実際に2件あり、どちらもZAICO値と異なる。" +
      "空欄なら補完し、入っていれば触らない。",
  },
  {
    field: "width",
    label: "幅",
    policy: "FILL_IF_EMPTY",
    reason:
      "ZAICOの寸法は自由記述で「座面直径34」のように送料判定へ使えない値が入る。" +
      "人が外形寸法を補ったら、それを毎回の同期で潰さない。",
  },
  {
    field: "depth",
    label: "奥行",
    policy: "FILL_IF_EMPTY",
    reason: "幅と同じ。ZAICOは「脚幅44」のような部分寸法を返すことがあり、人が入れた外形値を潰さない。",
  },
  {
    field: "height",
    label: "高さ",
    policy: "FILL_IF_EMPTY",
    reason: "幅と同じ。ZAICOは「75 フットレスト高さ25.5」のような複数値を返すため、人の整形結果を残す。",
  },
  {
    field: "overallLength",
    label: "全長",
    policy: "FILL_IF_EMPTY",
    reason:
      "寸法系。ZAICOの全長は「ワイヤー長さ72」「座面奥行き43座面高さ44」のような自由記述で、" +
      "人が整えた値のほうが業務で使える。空欄のときだけ補完する。",
  },

  // ── 個別判断 ──────────────────────────────────────────────────
  {
    field: "salePrice",
    label: "販売価格(成約)",
    policy: "MANUAL_REVIEW",
    reason:
      "成約後の実売価格で、売上集計の元になる。ZAICOが台帳の正本だが、食い違いは" +
      "「どちらかが誤り」を意味するので黙って上書きも据え置きもしない。差分を人へ出す。",
  },

  // ── ZAICO常時優先(明示しておきたいもの) ──────────────────────
  {
    field: "quantity",
    label: "数量",
    policy: "ZAICO_ALWAYS",
    reason: "在庫数の正本はZAICO。人が編集した履歴も無い。",
  },
  {
    field: "purchasePrice",
    label: "購入価格",
    policy: "ZAICO_ALWAYS",
    reason: "仕入・古物台帳の法定記録。ZAICOが正本で、人の編集履歴も無い。",
  },
  {
    field: "name",
    label: "商品名",
    policy: "ZAICO_ALWAYS",
    reason: "ZAICOのtitleが正本。人の編集履歴は無い。",
  },
];

/** 表に無い項目の既定。 */
export const DEFAULT_POLICY: ZaicoFieldPolicy = "ZAICO_ALWAYS";

const RULES_BY_FIELD = new Map(ZAICO_FIELD_RULES.map((r) => [r.field, r]));

export function policyFor(field: string): ZaicoFieldPolicy {
  return RULES_BY_FIELD.get(field)?.policy ?? DEFAULT_POLICY;
}

export function ruleFor(field: string): ZaicoFieldRule | null {
  return RULES_BY_FIELD.get(field) ?? null;
}

/**
 * 画像は値の突き合わせではなく「消さない」規則で守る。
 *
 * 人が写真を追加する運用があり(履歴で23件)、ZAICOは商品につき1枚しか
 * 持たない。ZAICOの1枚でBELLOの複数枚を置き換えると人の作業が消える。
 * 既存の同期実装も原本を消さない設計なので、ここでは方針として明文化
 * するにとどめ、判定ロジックは持たない。
 */
export const IMAGE_POLICY_NOTE =
  "画像はBELLO優先(追加のみ)。ZAICO由来の1枚は originalHash で重複判定し、人が足した写真は削除しない。";

/**
 * KEEP(書き込まない)の理由の**種別**。
 *
 * 以前は理由の日本語文を `reason.includes("人が変更")` のように
 * 文字列一致で分類していた。文面を少し直しただけで分類が静かに外れ、
 * 「人の編集を守ったこと」が報告に載らなくなる —— 守れてはいるが誰も
 * 知らされない、という一番気づきにくい壊れ方をする。種別を値で持つ。
 */
export type KeepKind =
  /** ZAICO側が空。空で既存値を消さない。報告する必要は無い。 */
  | "ZAICO_EMPTY"
  /** 値が同じ。書き込む必要が無い。報告する必要は無い。 */
  | "SAME_VALUE"
  /** 人が編集した値を守った。**必ず報告する。** */
  | "HUMAN_EDIT"
  /** BELLO側に値があるので補完しなかった。**報告する。** */
  | "ALREADY_FILLED"
  /** 前回のZAICO値が無く、人の編集か判断できないので安全側へ倒した。**報告する。** */
  | "NO_SNAPSHOT";

/** 報告に載せるべきKEEPかどうか。「据え置いた」と伝える意味があるものだけ。 */
export function shouldReportKeep(kind: KeepKind): boolean {
  return kind === "HUMAN_EDIT" || kind === "ALREADY_FILLED" || kind === "NO_SNAPSHOT";
}

export type UpdateDecision =
  /** ZAICOの値を書き込む。 */
  | { action: "APPLY"; value: unknown; reason: string }
  /** 書き込まない(BELLOの値を残す)。 */
  | { action: "KEEP"; kind: KeepKind; reason: string }
  /** 書き込まないが、食い違いを人へ提示する。 */
  | { action: "CONFLICT"; belloValue: unknown; zaicoValue: unknown; reason: string };

/** 値が「空」か。null / undefined / 空文字 / 空白のみ を空とみなす。 */
export function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  return false;
}

/** 比較用の正規化。数値の 1 と "1"、前後空白の違いで「変わった」と誤判定しない。 */
function normalizeForCompare(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v.trim();
  return JSON.stringify(v);
}

/**
 * 片方が数値で、もう片方が数値に読める文字列なら、数として比べる。
 *
 * ZAICOは数量を `"2.0"` のような**文字列**で返す(実測。数量が全件0に
 * なっていた件の原因もこれだった)。BELLO側は integer で持っているので、
 * 文字列として比べると `2` と `"2.0"` が「違う」ことになる。すると:
 *
 *   ・数量はZAICO常時優先なので、毎回「変わった」と判定して全件書き込む
 *   ・人優先の項目では、BELLOの 2 と スナップショットの "2.0" が
 *     食い違うため「人が変更した」と誤認し、**永久に据え置いて毎回
 *     警告を出し続ける**
 *
 * 両方が文字列の場合は数として比べない —— `"007"` と `"7"` は別物で
 * ありうる(バーコード・型番など)。片方が実際の数値のときだけ、
 * 「同じ数を指しているか」を見る。
 */
function numericallyEqual(a: unknown, b: unknown): boolean {
  const pair =
    typeof a === "number" && typeof b === "string"
      ? ([a, b] as const)
      : typeof b === "number" && typeof a === "string"
        ? ([b, a] as const)
        : null;
  if (!pair) return false;
  const [num, str] = pair;
  const trimmed = str.trim();
  if (trimmed === "") return false;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed === num;
}

export function valuesEqual(a: unknown, b: unknown): boolean {
  if (numericallyEqual(a, b)) return true;
  return normalizeForCompare(a) === normalizeForCompare(b);
}

export interface ResolveInput {
  field: string;
  /** 今回ZAICOが渡してきた値。 */
  zaicoValue: unknown;
  /** いまBELLOに入っている値。 */
  belloValue: unknown;
  /**
   * 前回の同期でZAICOが渡した値。スナップショットが無ければ undefined。
   * undefined は「誰が入れた値か分からない」を意味する。
   */
  lastZaicoValue: unknown | undefined;
  /** 新規作成中か。新規なら人の編集は存在しえないので、常にZAICOを入れる。 */
  isNewRecord?: boolean;
}

/**
 * 1項目ぶんの更新可否を決める。
 *
 * 【共通の前提】ZAICO側が空なら、どの方針でも書き込まない。
 * 空で既存値を消すのは、どの分類にも属さない事故でしかない。
 */
export function resolveFieldUpdate(input: ResolveInput): UpdateDecision {
  const { field, zaicoValue, belloValue, lastZaicoValue, isNewRecord } = input;
  const policy = policyFor(field);

  if (isEmptyValue(zaicoValue)) {
    return { action: "KEEP", kind: "ZAICO_EMPTY", reason: "ZAICO側が空。空で既存値を消さない。" };
  }
  if (isNewRecord) {
    return { action: "APPLY", value: zaicoValue, reason: "新規作成。人の編集は存在しない。" };
  }
  if (valuesEqual(zaicoValue, belloValue)) {
    return { action: "KEEP", kind: "SAME_VALUE", reason: "値が同じ。書き込む必要が無い。" };
  }

  switch (policy) {
    case "ZAICO_ALWAYS":
      return { action: "APPLY", value: zaicoValue, reason: "ZAICOが正本の項目。" };

    case "FILL_IF_EMPTY":
      return isEmptyValue(belloValue)
        ? { action: "APPLY", value: zaicoValue, reason: "BELLO側が空欄なので補完する。" }
        : { action: "KEEP", kind: "ALREADY_FILLED", reason: "BELLO側に値がある。空欄のときだけ補完する項目。" };

    case "HUMAN_WINS": {
      if (lastZaicoValue === undefined) {
        // 前回値を知らない = 誰が入れた値か分からない。人の入力を消す側へ
        // 倒さない。次回からはスナップショットがあるので判定できる。
        return {
          action: "KEEP",
          kind: "NO_SNAPSHOT",
          reason: "前回のZAICO値が記録されていないため、人の編集かどうか判断できない。安全側で据え置く。",
        };
      }
      if (valuesEqual(belloValue, lastZaicoValue)) {
        return { action: "APPLY", value: zaicoValue, reason: "前回のZAICO値のまま = 人は触っていない。" };
      }
      return {
        action: "KEEP",
        kind: "HUMAN_EDIT",
        reason: "前回のZAICO値と違う = 人が変更している。ZAICOで戻さない。",
      };
    }

    case "MANUAL_REVIEW":
      return {
        action: "CONFLICT",
        belloValue,
        zaicoValue,
        reason: "自動では判断しない項目。どちらが正しいかを人が決める。",
      };
  }
}

/**
 * customFields はキー単位で判定する。
 *
 * オブジェクト全体を1つの値として扱うと、「人が1キー消した」と
 * 「ZAICOが1キー増やした」が区別できない。
 */
export interface CustomFieldsResolution {
  merged: Record<string, unknown>;
  /** 人が消したと判断してZAICOの値を戻さなかったキー。 */
  keptDeleted: string[];
  /** 人が書き換えたと判断して据え置いたキー。 */
  keptModified: string[];
  /** ZAICOの値を入れたキー。 */
  applied: string[];
}

export function resolveCustomFields(params: {
  zaico: Record<string, unknown>;
  bello: Record<string, unknown>;
  lastZaico: Record<string, unknown> | undefined;
  isNewRecord?: boolean;
}): CustomFieldsResolution {
  const { zaico, bello, lastZaico, isNewRecord } = params;
  const merged: Record<string, unknown> = { ...bello };
  const keptDeleted: string[] = [];
  const keptModified: string[] = [];
  const applied: string[] = [];

  for (const [key, zaicoValue] of Object.entries(zaico)) {
    if (isEmptyValue(zaicoValue)) continue;

    if (isNewRecord) {
      merged[key] = zaicoValue;
      applied.push(key);
      continue;
    }

    const belloHasKey = Object.prototype.hasOwnProperty.call(bello, key) && !isEmptyValue(bello[key]);
    const lastValue = lastZaico ? lastZaico[key] : undefined;

    if (!belloHasKey) {
      // BELLO に無い。前回ZAICOが同じキーを渡していたなら、人が消したということ。
      if (lastZaico && Object.prototype.hasOwnProperty.call(lastZaico, key) && !isEmptyValue(lastValue)) {
        keptDeleted.push(key);
        continue;
      }
      merged[key] = zaicoValue;
      applied.push(key);
      continue;
    }

    if (valuesEqual(bello[key], zaicoValue)) continue; // 同じ。何もしない。

    if (lastValue === undefined) {
      // 前回値が分からない。人の値を消さない。
      keptModified.push(key);
      continue;
    }
    if (valuesEqual(bello[key], lastValue)) {
      merged[key] = zaicoValue;
      applied.push(key);
    } else {
      keptModified.push(key);
    }
  }

  return { merged, keptDeleted, keptModified, applied };
}

/**
 * 今回ZAICOが渡した値を、次回の3-way判定のためのスナップショットへ畳む。
 *
 * **BELLOへ実際に書き込んだかどうかに関わらず、ZAICOが渡した値を記録する。**
 * 記録するのは「ZAICOが何と言ってきたか」であって「BELLOが何になったか」
 * ではない。ここを取り違えると、人が変更した項目が次回「前回値と同じ」に
 * 見えてしまい、2回目の同期で結局上書きされる。
 */
export function buildZaicoSnapshot(zaicoValues: Record<string, unknown>): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(zaicoValues)) {
    if (isEmptyValue(value)) continue;
    snapshot[key] = value;
  }
  return snapshot;
}

export function parseSnapshot(raw: string | null | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    // 壊れたJSONは「スナップショット無し」として扱う。安全側(据え置き)へ倒れる。
    return undefined;
  }
}
