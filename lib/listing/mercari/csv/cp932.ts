import iconv from "iconv-lite";

/**
 * CP932への「厳密」エンコード。
 *
 * iconv-liteはCP932で表現できない文字を既定で置換してしまう(黙って`?`
 * 等へ変わる)ため、そのままでは「表現不能文字は対象位置と文字を示し
 * 停止、?置換/黙った削除禁止」という要件を満たせない。
 * そこでencode→decodeのラウンドトリップを取り、元の文字列と一致しない
 * 箇所を「表現不能文字」として検出する。
 */
export interface Cp932EncodeOk {
  ok: true;
  buffer: Buffer;
}

export interface Cp932EncodeError {
  ok: false;
  /** 表現できなかった文字(Unicodeコードポイント単位)。 */
  invalidChar: string;
  /** `text`内でのコードポイント位置(0始まり)。 */
  charIndex: number;
}

export type Cp932EncodeResult = Cp932EncodeOk | Cp932EncodeError;

export function encodeCp932Strict(text: string): Cp932EncodeResult {
  const buffer = iconv.encode(text, "cp932");
  const roundTrip = iconv.decode(buffer, "cp932");
  if (roundTrip === text) {
    return { ok: true, buffer };
  }

  const original = Array.from(text);
  const decoded = Array.from(roundTrip);
  const length = Math.max(original.length, decoded.length);
  for (let i = 0; i < length; i++) {
    if (original[i] !== decoded[i]) {
      return { ok: false, invalidChar: original[i] ?? "", charIndex: i };
    }
  }
  // 理論上ここには来ない(差分があればループ内で見つかるはず)が、
  // 保険として末尾を指す。
  return { ok: false, invalidChar: original[original.length - 1] ?? "", charIndex: Math.max(0, original.length - 1) };
}

/** 文字列がCP932で完全往復できるかどうかだけを返す軽量版。 */
export function isCp932Representable(text: string): boolean {
  return encodeCp932Strict(text).ok;
}

/** テスト/独立検証用 — CP932バイト列を文字列へ戻す。 */
export function decodeCp932(buffer: Buffer): string {
  return iconv.decode(buffer, "cp932");
}
