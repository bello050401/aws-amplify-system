/** These statements promise an external action, not a product fact or a customer request. */
export function detectUnverifiedFulfillment(text: string): string[] {
  const normalized = (text ?? "").normalize("NFKC");
  const sentences = normalized.split(/[。！？\n]/).map(s => s.replace(/[ \t]+/g, ""));
  const promises = sentences.some(s =>
    /(?:お届け|配送|発送|出荷|配達)(?:いたし|し|させていただき)ます/.test(s) ||
    /(?:お届け|配送|発送|出荷|配達)[^。]{0,100}(?:手配|予約|確保)(?:いたし|し|させていただき)(?:ます|ました)/.test(s) ||
    /(?:お届け|配送|発送|出荷|配達)[^。]{0,100}(?:確定しました|確定しております|確定しています|手配済み|予約済み|確保済み)/.test(s) ||
    /(?:配送会社|配送業者|運送会社)[^。]{0,100}(?:メール|電話|連絡)[^。]{0,40}(?:届きます|いたします|されます|ございます)/.test(s)
  );
  return promises ? ["配送日時・手配の未確認の約束"] : [];
}
