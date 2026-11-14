import type { ProductCategory } from './types';

/** Derived display categories only. Never writes workflow categories or confirms a product kind. */
export const TITLE_CATEGORY_VERSION = 1;
export const TITLE_CATEGORIES: readonly ProductCategory[] = [
  { id: 'sofa', label: 'ソファ' }, { id: 'table-desk', label: 'テーブル・デスク' },
  { id: 'dining-chair', label: 'ダイニングチェア' }, { id: 'personal-chair', label: 'パーソナルチェア' },
  { id: 'work-chair', label: 'ワークチェア' }, { id: 'stool', label: 'スツール' },
  { id: 'bench-ottoman', label: 'ベンチ・オットマン' }, { id: 'storage', label: '収納家具' },
  { id: 'lighting', label: '照明' }, { id: 'interior-art', label: 'インテリア・アート' },
  { id: 'chair-unspecified', label: '椅子（用途未分類）' }, { id: 'other', label: 'その他商品' },
];

export const CATEGORY_COLORS: Readonly<Record<string, string>> = {
  sofa: '#264e47', 'table-desk': '#ad7b4f', 'dining-chair': '#659e98',
  'personal-chair': '#496b7d', 'work-chair': '#779bb9', stool: '#d09b4d',
  'bench-ottoman': '#87975a', storage: '#8c779c', lighting: '#beaa5b',
  'interior-art': '#b9858d', 'chair-unspecified': '#8696a0', other: '#868f88',
};

export function categoryTitle(raw: string | null | undefined): string {
  if (!raw) return '';
  // Full-width digits and Latin letters may differ; normalization is read-only.
  let title = raw.normalize('NFKC').trim();
  // Notes sometimes mention a different item. Remove complete leading management tags only.
  title = title.replace(/^(?:[\s☆※]*【[^】]*】\s*|[\s☆※]*《[^》]*》\s*)+/u, '');
  // Related/search terms advertise other products and cannot determine this item's category.
  title = title.split(/(?:関連(?:商品|ワード|語)?\s*[:：]?|検索(?:用|ワード)?\s*[:：]|検\s*[:：])/u, 1)[0];
  return title.toLowerCase();
}

/** Explicit product nouns, with ambiguity left visible instead of guessing a chair's use. */
export function categoryFromTitle(raw: string | null | undefined): string | null {
  const original = raw?.normalize('NFKC') ?? '';
  const title = categoryTitle(raw);
  if (!title) return null;
  if (/【[^】]*(?:脚のみ|部材のみ|天板のみ|カバーのみ)[^】]*】/u.test(original)) return 'other';
  const lighting = /(?:照明|ランプ|ペンダントライト|フロアライト|シーリングライト|スタンドライト|テーブルライト|シャンデリア|\blamps?\b|\blights?\b|\bchandeliers?\b)/iu.test(title);
  const storagePattern = /(?:収納|キャビネット|チェスト|サイドボード|テレビボード|ローボード|シェルフ|本棚|書棚|食器棚|電話台|マガジンラック|\bcabinets?\b|\bsideboards?\b|\bshel(?:f|ves)\b|\bchests?\b)/iu;
  const artPattern = /(?:オブジェ|アート|絵画|油絵|抽象画|水墨画|ポスター|花瓶|花器|フラワーベース|ふらわーべーす|彫刻|置物|ミラー|鏡|ラグ|\bvases?\b|\bsculptures?\b|\bmirrors?\b|\brugs?\b)/iu;
  const otherPattern = /(?:部材|交換部品|交換用カバー|専用カバーのみ|コードアジャスター|マットレス|\b(?:bed)?mattress(?:es)?\b|有機el|液晶テレビ|パーテーション|間仕切り|スクリーン|コートスタンド|コートハンガー|ポールハンガー|\bpartitions?\b|\bcoat\s+(?:stands?|racks?)\b)/iu;
  // Detect explicit mixed sets after removing compound nouns such as table lamp/desk chair.
  const components = title.replace(/(?:テーブル|デスク)(?:ランプ|ライト)|\b(?:table|desk)\s+(?:lamps?|lights?)\b/giu,'照明')
    .replace(/デスクチェア|\bdesk\s+chairs?\b/giu,'ワークチェア').replace(/アートワークスタジオ/gu,'');
  const componentKinds = [
    /ソファ|\bsofas?\b|\bcouch(?:es)?\b/iu.test(components),
    /チェア|椅子|スツール|\bchairs?\b|\barmchairs?\b|\bstools?\b/iu.test(components),
    /ベンチ|オットマン|\bbench(?:es)?\b|\bottomans?\b/iu.test(components),
    /テーブル|デスク|\btables?\b|\bdesks?\b/iu.test(components),
    storagePattern.test(components), artPattern.test(components), otherPattern.test(components),
    lighting,
  ];
  const loungeWithOttoman = /ラウンジチェア|パーソナルチェア|\blounge\s+chair\b/iu.test(title)
    && /オットマン|\bottoman\b/iu.test(title) && !/ベンチ|\bbench\b/iu.test(title)
    && componentKinds.filter(Boolean).length === 2;
  if (/(?:と|[+＋]|\band\b|セット|\bset\b|一式)/iu.test(title)
      && componentKinds.filter(Boolean).length > 1 && !loungeWithOttoman) return null;
  if (otherPattern.test(title) && /部材|交換部品|交換用カバー|専用カバーのみ|コードアジャスター|マットレス|\bmattress(?:es)?\b|\bbedmattress\b|有機el|液晶テレビ/iu.test(title)) return 'other';
  if (lighting) return 'lighting';
  const work = /(?:ワークチェア|デスクチェア|オフィスチェア|エグゼクティブチェア|タスクチェア|\b(?:office|desk|task|executive)\s+chair\b)/iu.test(title);
  const dining = /(?:ダイニングチェア|\bdining\s+chair\b)/iu.test(title);
  const lounge = /(?:パーソナルチェア|ラウンジチェア|イージーチェア|リクライニングチェア|\b(?:lounge|easy|personal|reclining)\s+chair\b)/iu.test(title);
  const stool = /(?:スツール|ハイチェア|カウンターチェア|バーチェア|\b(?:bar\s*)?stools?\b)/iu.test(title);
  const sofa = /(?:ソファ|\bsofas?\b|\bcouch\b)/iu.test(title);
  const bench = /(?:ベンチ|オットマン|フットスツール|\bbench\b|\bottoman\b|\bfootstool\b)/iu.test(title);
  const table = /(?:テーブル|デスク|\btable\b|\bdesk\b)/iu.test(title);
  const chair = /(?:チェア|椅子|\bchairs?\b|\barmchairs?\b)/iu.test(title);
  // Don't allocate an entire mixed furniture set to the first matching noun.
  if (table && (sofa || stool || bench || (chair && !work))) return null;
  if (sofa && stool) return null;
  // A lounge chair with an ottoman is a chair set; a standalone ottoman is separate.
  if (stool && !/フットスツール|\bfootstool\b/iu.test(title)) return 'stool';
  if (work && !dining) return 'work-chair';
  if (dining && !work && !lounge) return 'dining-chair';
  if (lounge && !sofa && !dining) return 'personal-chair';
  // Titles using both single-seat sofa and lounge chair are not enough to settle that boundary.
  if (sofa && lounge) return null;
  if (sofa) return 'sofa';
  if (bench && !work && !dining && !lounge) return 'bench-ottoman';
  if (table) return 'table-desk';
  if (chair) return 'chair-unspecified';
  if (storagePattern.test(title)) return 'storage';
  if (artPattern.test(title)) return 'interior-art';
  if (otherPattern.test(title)) return 'other';
  return null;
}
