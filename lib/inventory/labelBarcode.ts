/** The legacy printed label number lives in 市川メモ on some ZAICO records. */
export function memoLabelBarcode(memo: string | null | undefined): string | null {
  const text = (memo ?? "").normalize("NFKC");
  const allNumbers = new Set([...text.matchAll(/(?<!\d)\d{13}(?!\d)/g)].map(match => match[0]));
  if (allNumbers.size !== 1) return null;
  const candidates = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    // Accept a standalone 13-digit label or an explicitly labelled code line.
    // Never turn prices, telephone numbers, URLs or arbitrary prose into a code.
    const match = /^(?:QR(?:コード)?|バーコード|コード)?\s*[:：]?\s*(\d{13})\s*$/i.exec(line.trim());
    if (match) candidates.add(match[1]);
  }
  // Multiple package codes require an explicit choice; do not guess the first.
  return candidates.size === 1 ? [...candidates][0] : null;
}

export function isGeneratedZaicoBarcode(code: string | null | undefined): boolean {
  return /^tw(?:\d+|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test((code ?? "").trim());
}

/** Preserve explicit codes; replace only missing/auto-generated codes with the printed label. */
export function resolveLabelBarcode(code: string | null | undefined, memo: string | null | undefined): string | null {
  const current = code?.trim() || null;
  if (current && !isGeneratedZaicoBarcode(current)) return current;
  return memoLabelBarcode(memo) ?? current;
}
