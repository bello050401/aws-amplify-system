import { ZAICO_FIELD_CHOICES } from '../inventory/zaicoFieldChoices';

// Use the same existing choices as the inventory editor and ZAICO mapping.
export const PROCUREMENT_IDENTITY_METHOD = ZAICO_FIELD_CHOICES.identityVerificationMethod[1];
export const PROCUREMENT_OCCUPATION = ZAICO_FIELD_CHOICES.counterpartyOccupation[0];

type Rule = readonly [string, RegExp];
const brands: Rule[] = [
  ['Walter Knoll', /walter\s*knoll|ワルタ[ー]?ノール/i],
  ['COMPLEX UNIVERSAL FURNITURE SUPPLY', /complex(?:\s+universal\s+furniture\s+supply)?|コンプレックス(?:ユニバーサルファニチャーサプライ)?/i],
  ['Stellar Works', /stellar\s*works|ステラワークス/i],
  ['Cassina', /\bcassina\b|カッシーナ/i], ['arper', /\barper\b|アルペール/i],
  ['arflex', /\barflex\b|アルフレックス/i], ['Vitra', /\bvitra\b|ヴィトラ|ビトラ/i],
  ['Herman Miller', /herman\s*miller|ハーマンミラー/i], ['Fritz Hansen', /fritz\s*hansen|フリッツハンセン/i],
  ['B&B Italia', /b\s*&\s*b\s*italia|ビーアンドビー/i], ['Carl Hansen & Søn', /carl\s*hansen|カールハンセン/i],
  ['Knoll', /\bknoll\b|ノール/i], ['HAY', /\bhay\b|ヘイ/i], ['MAGIS', /\bmagis\b|マジス/i],
  ['Kartell', /\bkartell\b|カルテル/i], ['Wilkhahn', /\bwilkhahn\b|ウィルクハーン/i],
  ['ACTUS', /\bactus\b|アクタス/i], ['カリモク', /karimoku|カリモク/i],
  ['コクヨ', /\bkokuyo\b|コクヨ/i], ['オカムラ', /\bokamura\b|オカムラ/i],
  ['パモウナ', /pamouna|パモウナ/i], ['パナソニック', /panasonic|パナソニック/i],
  ['ハイセンス', /hisense|ハイセンス/i],
];
const kinds: Rule[] = [
  ['センターテーブル', /センターテーブル|ローテーブル|center\s*table|low\s*table/i],
  ['サイドテーブル', /サイドテーブル|side\s*table/i],
  ['ダイニングテーブル', /ダイニングテーブル|dining\s*table/i],
  ['カフェテーブル', /カフェテーブル|コーヒー\s*テーブル|cafe\s*table|coffee\s*table/i],
  ['テーブル', /テーブル|\btable\b/i], ['デスク', /デスク|机|\bdesk\b/i],
  ['アームチェア', /アームチェア|arm\s*chair/i], ['ラウンジチェア', /ラウンジチェア|lounge\s*chair/i],
  ['スツール', /スツール|\bstool\b/i], ['ソファ', /ソファ|\bsofa\b/i], ['ベンチ', /ベンチ|\bbench\b/i],
  ['椅子', /チェア|椅子|\bchair\b/i], ['サイドボード', /サイドボード|sideboard/i],
  ['ローボード', /ローボード|テレビボード/i], ['棚', /棚|ラック|キャビネット|シェルフ|書庫|shelf|cabinet/i],
  ['照明', /照明|ランプ|ライト|シャンデリア|\blamp\b/i], ['コートハンガー', /コートハンガー/i],
  ['冷蔵庫', /冷蔵庫/i], ['洗濯機', /洗濯機/i], ['電子レンジ', /電子レンジ/i],
];
// Specific colours precede their component colours (wine red must not become two colours).
const colors: Rule[] = [
  ['ワインレッド', /ワインレッド|wine\s*red/i], ['ダークブラウン', /ダークブラウン|dark\s*brown/i],
  ['ライトブラウン', /ライトブラウン|light\s*brown/i], ['ネイビー', /ネイビー|紺|\bnavy\b/i],
  ['ホワイト', /ホワイト|白(?:色)?|\bwhite\b/i], ['ブラック', /ブラック|黒(?:色)?|\bblack\b/i],
  ['グレー', /グレー|灰色|\bgr[ae]y\b/i], ['ベージュ', /ベージュ|\bbeige\b/i],
  ['ブラウン', /ブラウン|茶色|\bbrown\b/i], ['レッド', /レッド|赤(?:色)?|\bred\b/i],
  ['ブルー', /ブルー|青(?:色)?|\bblue\b/i], ['グリーン', /グリーン|緑(?:色)?|\bgreen\b/i],
  ['イエロー', /イエロー|黄色|\byellow\b/i], ['ピンク', /ピンク|\bpink\b/i],
  ['オレンジ', /オレンジ|\borange\b/i], ['パープル', /パープル|紫(?:色)?|\bpurple\b/i],
  ['シルバー', /シルバー|銀色|\bsilver\b/i], ['ゴールド', /ゴールド|金色|\bgold\b/i],
];
const shapes: Rule[] = [
  ['楕円形', /楕円(?:形)?|オーバル(?:型)?|\boval\b/i], ['半円形', /半円(?:形)?/],
  ['円形', /円形|丸型|丸形|ラウンド|\bround\b/i], ['長方形', /長方形|rectangular/i],
  ['正方形', /正方形|スクエア|\bsquare\b/i], ['三角形', /三角形|三角型|triangular/i],
  ['L字型', /L字(?:型|形)?/i],
];
const materials: Rule[] = [
  ['合成皮革', /合成皮革|合皮|フェイクレザー|PUレザー/i], ['本革', /本革|天然皮革/],
  ['布張り', /布張り|ファブリック|fabric/i], ['木製', /木製|ウッド|wood/i],
  ['アルミ', /アルミ|alumin(?:um|ium)/i], ['スチール', /スチール|steel/i],
  ['ガラス', /ガラス|\bglass\b/i], ['大理石', /大理石|marble/i],
];

/** Evidence from the title only. Do not infer a brand/colour from photos or
 * record related/search-keyword brands as the actual manufacturer's name. */
export function procurementFeature(title: string): string {
  const text = title.normalize('NFKC').replace(/(?:関連|検索用|検索ワード)\s*[:：]?.*$/iu, '');
  const brand = brands.find(([, re]) => re.test(text))?.[0];
  const kind = kinds.find(([, re]) => re.test(text))?.[0];
  let remaining = text;
  const colour = colors.flatMap(([label, re]) => {
    if (!re.test(remaining)) return [];
    remaining = remaining.replace(new RegExp(re.source, 'gi'), ' ');
    return [label];
  });
  const shape = shapes.find(([, re]) => re.test(text))?.[0];
  const material = materials.filter(([, re]) => re.test(text)).map(([label]) => label);
  return [brand && `ブランド：${brand}`, kind && `品目：${kind}`, colour.length && `色：${colour.join('・')}`,
    shape && `形：${shape}`, material.length && `素材：${material.join('・')}`].filter(Boolean).join('／');
}

export function procurementLedgerDetails(title: string) {
  return {
    identityVerificationMethod: PROCUREMENT_IDENTITY_METHOD,
    counterpartyOccupation: PROCUREMENT_OCCUPATION,
    customFields: { usedGoodsFeature: procurementFeature(title) },
  };
}
