/**
 * §4.1/§5(第三次: BELLOベンダー非依存仕様書): AI出力の品質ゲート
 * (純粋関数のみ、AWS/外部APIへ一切触れない — lib/inventory/sales.tsと
 * 同じ方針)。
 *
 * 【検査項目、仕様書§4.1どおり】必須情報欠落・禁止情報混入・商品事実
 * との矛盾・指定フォーマット違反・異常な文字数・不適切な断定・schema
 * validation failure。「商品事実との矛盾」はこのファイルだけでは判定
 * できない(呼び出し元がfactsを渡して比較する必要がある)ため、
 * checkTextQuality/checkStructuredQualityのoptions経由で呼び出し元が
 * 追加ルールを注入できる形にしてある。
 */

export interface QualityGateResult {
  pass: boolean;
  violations: string[];
}

/** 「自社内での連絡事項」等が生成結果へ漏れていないかの簡易パターン検査(§6/§58と同じ境界)。完全ではないが、明白な漏洩の一次検査として機能する。 */
const INTERNAL_LEAK_PATTERNS = [/仕入(れ)?原価/, /社内(のみ|限定|メモ)/, /adminMemo/i, /internal\s*note/i];

export interface TextQualityRules {
  minLength?: number;
  maxLength?: number;
  /** テキストに絶対含まれてはならない語(禁止情報 — 例: 未確定の値下げ約束等)。 */
  forbiddenPatterns?: RegExp[];
  /** テキストに必ず含まれるべき語(必須情報 — 例: 生成対象の商品名)。 */
  requiredSubstrings?: string[];
}

export function checkTextQuality(text: string, rules: TextQualityRules = {}): QualityGateResult {
  const violations: string[] = [];
  const trimmed = text.trim();

  if (trimmed.length === 0) violations.push("EMPTY_OUTPUT: 出力が空です。");
  if (rules.minLength != null && trimmed.length < rules.minLength) violations.push(`TOO_SHORT: 出力が短すぎます(${trimmed.length}文字 < ${rules.minLength}文字)。`);
  if (rules.maxLength != null && trimmed.length > rules.maxLength) violations.push(`TOO_LONG: 出力が長すぎます(${trimmed.length}文字 > ${rules.maxLength}文字)。`);

  for (const pattern of INTERNAL_LEAK_PATTERNS) {
    if (pattern.test(trimmed)) violations.push(`INTERNAL_LEAK_SUSPECTED: 内部情報の漏洩が疑われるパターンに一致しました(${pattern})。`);
  }
  for (const pattern of rules.forbiddenPatterns ?? []) {
    if (pattern.test(trimmed)) violations.push(`FORBIDDEN_CONTENT: 禁止パターンに一致しました(${pattern})。`);
  }
  for (const required of rules.requiredSubstrings ?? []) {
    if (!trimmed.includes(required)) violations.push(`MISSING_REQUIRED_INFO: 必須情報「${required}」が含まれていません。`);
  }

  return { pass: violations.length === 0, violations };
}

/** 構造化出力(tool use)の品質検査 — 必須フィールドの有無・空文字チェックのみ(型はTypeScript側で既に保証されている前提)。 */
export function checkStructuredQuality<T extends Record<string, unknown>>(output: T, requiredNonEmptyFields: (keyof T)[]): QualityGateResult {
  const violations: string[] = [];
  for (const field of requiredNonEmptyFields) {
    const value = output[field];
    const isEmpty = value == null || (typeof value === "string" && value.trim().length === 0) || (Array.isArray(value) && value.length === 0);
    if (isEmpty) violations.push(`SCHEMA_VIOLATION: 必須フィールド「${String(field)}」が空です。`);
  }
  return { pass: violations.length === 0, violations };
}
