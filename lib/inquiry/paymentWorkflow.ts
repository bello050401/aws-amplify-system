type Fact = { label: string; value: string };

/** Confirmed BELLO workflow; never redirects another marketplace's customer. */
export function officialLinePaymentFacts(channel: string, negotiation: boolean): Fact[] {
  return channel === 'LINE' && negotiation ? [{
    label: 'ご購入手続き・お支払い方法',
    value: 'ご購入をご希望の場合は、この公式LINEでBELLOから請求書をお送りし、銀行振込でお支払いいただきます。金額の合意前に請求書発行済み・入金済みとは案内しません。',
  }] : [];
}

/** Keep the approved payment condition even when the model omits it or AI is unavailable. */
export function ensureOfficialLinePaymentGuidance(text: string, channel: string, negotiation: boolean): string {
  if (!officialLinePaymentFacts(channel, negotiation).length) return text;
  if (/請求書/.test(text) && /銀行振込|銀行振り込/.test(text) && /(?:公式)?LINE|こちらのLINE/.test(text)) return text;
  return text.trim() + '\n\nご購入をご希望の場合は、この公式LINEで請求書をお送りし、銀行振込でお支払いいただく流れとなります。';
}
