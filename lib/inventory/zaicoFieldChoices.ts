/** Confirmed in ZAICO's field settings and input screen, 2026-10-20.
 * These six fields are single-select; categories remain multiple-select.
 * Keep legacy values visible instead of silently selecting the first option.
 */
export const ZAICO_FIELD_CHOICES = {
  lengthAdjustable: ["可能", "不可"],
  mountType: ["引掛けシーリング", "ダクトレール", "引掛けシーリング(要ネジ止め）", "要電気工事"],
  transactionType: ["買受", "委託", "交換"],
  identityVerificationMethod: [
    "本人確認書類（運転免許証、保険証、マイナンバー）",
    "対面している相手の勤務先や家族などに、身元確認の問い合わせ",
    "目の前で書面に住所、氏名、職業、年齢を記載",
  ],
  counterpartyOccupation: ["リサイクル販売業", "事務職", "営業職", "自営業"],
  market: ["直接取引", "ベイス", "メルカリSHOP", "ヤフオク", "メルカリ", "ラクマ", "雑収入", "トレファク業者間", "リステージ業者間", "バッタヤライブ"],
} as const;

export function choicesWithCurrentValue(options: readonly string[], current: string): string[] {
  return [...new Set(["", ...options, ...(current ? [current] : [])])];
}
