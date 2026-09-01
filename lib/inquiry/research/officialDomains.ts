/**
 * §9 メーカー・ブランドの公式ドメイン。純粋関数のみ。
 *
 * 【何のためか】AgentCore Web Search のリクエスト単位ドメイン絞り込み
 * (`filters.domainFilter.include`)へ渡し、**まず公式サイトだけを探す**
 * ために使う。仕様書§9の優先順位「メーカー公式 > ブランド公式 >
 * 公式カタログ > 公式取説 > 正規販売店 > その他」の、最初の2段を
 * 検索の時点で効かせる。
 *
 * 【網羅を目指さない】ここに無いブランドでも機能は動く —— 公式限定の
 * 1回目を飛ばして、範囲を絞らない検索へ進むだけ。誤ったドメインを
 * 書くほうが害が大きい(そのブランドの検索が空振りし続ける)ので、
 * 実在を確認できたものだけを載せる。
 *
 * ブランド名の表記ゆれは、既存の
 * lib/ai/productIntro/factSafety.ts の KNOWN_FURNITURE_BRANDS に
 * 合わせている(同じ綴りで引けるようにするため)。
 */

/** 小文字化したブランド名 → 公式ドメイン(複数可)。 */
const BRAND_OFFICIAL_DOMAINS: Record<string, string[]> = {
  // 照明
  daiko: ["lighting-daiko.co.jp"],
  大光電機: ["lighting-daiko.co.jp"],
  ダイコー: ["lighting-daiko.co.jp"],
  yamagiwa: ["yamagiwa.co.jp"],
  ヤマギワ: ["yamagiwa.co.jp"],
  "louis poulsen": ["louispoulsen.com"],
  ルイスポールセン: ["louispoulsen.com"],
  flos: ["flos.com"],
  フロス: ["flos.com"],
  artemide: ["artemide.com"],
  アルテミデ: ["artemide.com"],
  slamp: ["slamp.com"],
  スランプ: ["slamp.com"],
  odelic: ["odelic.co.jp"],
  オーデリック: ["odelic.co.jp"],
  koizumi: ["koizumi-lt.co.jp"],
  コイズミ: ["koizumi-lt.co.jp"],
  panasonic: ["panasonic.com", "panasonic.jp"],
  パナソニック: ["panasonic.com", "panasonic.jp"],

  // 家具
  hay: ["hay.dk", "hay.com"],
  muuto: ["muuto.com"],
  ムート: ["muuto.com"],
  boconcept: ["boconcept.com"],
  ボーコンセプト: ["boconcept.com"],
  vitra: ["vitra.com"],
  ヴィトラ: ["vitra.com"],
  ビトラ: ["vitra.com"],
  cassina: ["cassina.com", "cassina-ixc.jp"],
  カッシーナ: ["cassina.com", "cassina-ixc.jp"],
  usm: ["usm.com"],
  artek: ["artek.fi"],
  アルテック: ["artek.fi"],
  "fritz hansen": ["fritzhansen.com"],
  フリッツハンセン: ["fritzhansen.com"],
  "herman miller": ["hermanmiller.com", "hermanmiller.co.jp"],
  ハーマンミラー: ["hermanmiller.com", "hermanmiller.co.jp"],
  knoll: ["knoll.com"],
  ノル: ["knoll.com"],
  "carl hansen": ["carlhansen.com"],
  カールハンセン: ["carlhansen.com"],
  "&tradition": ["andtradition.com"],
  アンドトラディション: ["andtradition.com"],
  kartell: ["kartell.com"],
  カルテル: ["kartell.com"],
  magis: ["magisdesign.com"],
  マジス: ["magisdesign.com"],
  "b&b italia": ["bebitalia.com"],
  minotti: ["minotti.com"],
  ミノッティ: ["minotti.com"],
  poliform: ["poliform.it"],
  natuzzi: ["natuzzi.com"],
  ナツッジ: ["natuzzi.com"],
  ikea: ["ikea.com"],
  イケア: ["ikea.com"],
  無印良品: ["muji.com"],
  muji: ["muji.com"],
  karimoku: ["karimoku.co.jp", "karimoku-newstandard.jp"],
  カリモク: ["karimoku.co.jp", "karimoku-newstandard.jp"],
  天童木工: ["tendo-mokko.co.jp"],
  マルニ: ["maruni.com"],
  maruni: ["maruni.com"],
  arflex: ["arflex.co.jp", "arflex.it"],
  アルフレックス: ["arflex.co.jp", "arflex.it"],
  "ligne roset": ["ligne-roset.com"],
  リーンロゼ: ["ligne-roset.com"],
  "time & style": ["timeandstyle.com"],
  piiroinen: ["piiroinen.com"],
  "artek finland": ["artek.fi"],
  idee: ["idee-online.com"],
  artworkstudio: ["artworkstudio.co.jp"],
  アートワークスタジオ: ["artworkstudio.co.jp"],
  actus: ["actus-interior.com"],
};

/**
 * 商品名や問い合わせから拾ったブランド候補を、公式ドメインへ変換する。
 *
 * 大文字小文字と前後の空白は無視する。該当が無ければ空配列 ——
 * 呼び出し側は「公式限定の検索を行わず、範囲を絞らずに探す」へ倒す。
 */
export function officialDomainsForBrands(brands: readonly string[]): string[] {
  const domains: string[] = [];
  for (const brand of brands) {
    const key = brand.trim().toLowerCase();
    const hit = BRAND_OFFICIAL_DOMAINS[key];
    if (hit) domains.push(...hit);
  }
  return [...new Set(domains)];
}

/**
 * 商品名からブランド候補を拾う。
 *
 * 問い合わせ本文にブランド名が出てこない場合でも、在庫の商品名には
 * 入っていることが多い(実データで確認)。ただし商品名末尾の
 * 「検:」以降は他社の検索用キーワードなので、呼び出し側が
 * scoring.ts の nameCore() で落としてから渡すこと。
 */
export function brandsInText(text: string): string[] {
  const found: string[] = [];
  const haystack = text.toLowerCase();
  for (const key of Object.keys(BRAND_OFFICIAL_DOMAINS)) {
    if (/^[\x20-\x7E]+$/.test(key)) {
      // 英字ブランドは単語境界を要求する("hay"が"highway"に当たらないように)。
      const re = new RegExp(`(^|[^a-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
      if (re.test(haystack)) found.push(key);
    } else if (text.includes(key)) {
      found.push(key);
    }
  }
  return [...new Set(found)];
}

/** 既知の公式ドメイン一覧(classifySourceへ渡して MANUFACTURER と判定させる)。 */
export function allOfficialDomains(): string[] {
  return [...new Set(Object.values(BRAND_OFFICIAL_DOMAINS).flat())];
}
