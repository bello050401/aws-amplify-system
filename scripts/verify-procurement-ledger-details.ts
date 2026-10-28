import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { procurementFeature, procurementLedgerDetails, PROCUREMENT_IDENTITY_METHOD } from '../lib/procurement/ledgerDetails';
import { restageInventoryFields, type RestageLot } from '../lib/procurement/restage';
import { encodeZaicoPhoto } from '../lib/zaico/transition/photoEncoding';
import { procurementPhoto, needsPhoto } from '../lib/zaico/transition/images';
import { localFields, outgoingPatch } from '../lib/zaico/transition/mapping';

test('タイトルからブランド・品目・色・形・素材を抽出し関連語は除外', () => {
  assert.equal(procurementFeature('walter knoll/ワルターノール■369 アームチェア■ワインレッド系■ラウンジチェア'), 'ブランド：Walter Knoll／品目：アームチェア／色：ワインレッド');
  assert.equal(procurementFeature('COMPLEX UNIVERSAL FURNITURE SUPPLY / コンプレックスユニバーサルファニチャーサプライ■Rainer Chair/ライナーチェア'), 'ブランド：COMPLEX UNIVERSAL FURNITURE SUPPLY／品目：椅子');
  assert.equal(procurementFeature('Cassina カッシーナ 261 NOTE ノート センターテーブル Piero Lissoni アルミ ホワイト'), 'ブランド：Cassina／品目：センターテーブル／色：ホワイト／素材：アルミ');
  assert.equal(procurementFeature('Stellar Works / ステラワークス■Blink Cafe Table - Wood Top / ブリンク カフェテーブル ウッドトップ■コーヒーテーブル'), 'ブランド：Stellar Works／品目：カフェテーブル／素材：木製');
  assert.equal(procurementFeature('arper /アルペール■Dizzie コーヒー テーブル ■サイドテーブル■ホワイト■オーバル型'), 'ブランド：arper／品目：サイドテーブル／色：ホワイト／形：楕円形');
  assert.equal(procurementFeature('【円形】【在庫3】テーブル ブラック 関連: Cassina'), '品目：テーブル／色：ブラック／形：円形');
  assert.equal(procurementFeature('商品A'), '');
  assert.equal(procurementFeature('半円形 木製テーブル ホワイト ブラック'), '品目：テーブル／色：ホワイト・ブラック／形：半円形／素材：木製');
});
test('両仕入れで既存の台帳項目を使用しZAICOの追加属性へ送信', () => {
  const defaults = procurementLedgerDetails('Cassina ホワイト テーブル');
  const restage = restageInventoryFields({ name: 'Cassina ホワイト テーブル', quantity: 2, hammerPrice: 1000 } as RestageLot);
  assert.equal(restage.identityVerificationMethod, PROCUREMENT_IDENTITY_METHOD);
  assert.equal(restage.counterpartyOccupation, 'リサイクル販売業');
  assert.deepEqual(restage.customFields, defaults.customFields);
  const fields = localFields({ ...defaults, customFields: JSON.stringify(defaults.customFields) });
  const payload = outgoingPatch({ identityVerificationMethod: fields.identityVerificationMethod, counterpartyOccupation: fields.counterpartyOccupation, 'custom.usedGoodsFeature': fields['custom.usedGoodsFeature'] }, undefined, { categories: [], locations: [], statuses: [], resolve: async () => '' });
  assert.equal(payload.optional_attributes['⚫︎職業'], 'リサイクル販売業');
  assert.equal(payload.optional_attributes['⚫︎古物の特徴'], defaults.customFields.usedGoodsFeature);
});
test('ヤフオク・リステージ写真だけを連動対象にし既存写真・削除済みは保護', () => {
  for (const flag of ['__yahooPurchaseImport', '__restageImport']) {
    const row = { customFields: JSON.stringify({ [flag]: { id: '1' } }), images: [{ type: 'NORMAL', storageKey: 'inventory/1.jpg', isPrimary: true }] };
    assert(needsPhoto(row, {}));
    assert(!needsPhoto(row, { remote: { item_image: { url: 'existing' } } }));
    assert(!needsPhoto(row, { imageExport: { fingerprint: procurementPhoto(row)!.fingerprint } }));
    assert(!needsPhoto({ ...row, deletedAt: 'now' }, {}));
    assert(!needsPhoto({ ...row, images: [{ ...row.images[0], deletedAt: 'now' }] }, {}));
  }
  assert(!procurementPhoto({ customFields: {}, images: [{ type: 'NORMAL', storageKey: 'inventory/1.jpg' }] }));
});
test('JPEG原本はそのまま送信、WebPは原本を変更せずJPEGに変換', async () => {
  const jpeg = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#e19256' } }).jpeg().toBuffer();
  assert.equal(await encodeZaicoPhoto(jpeg), 'data:image/jpeg;base64,' + jpeg.toString('base64'));
  const webp = await sharp(jpeg).webp().toBuffer(), original = Buffer.from(webp);
  const encoded = await encodeZaicoPhoto(webp);
  assert.match(encoded, /^data:image\/jpeg;base64,/);
  assert.equal((await sharp(Buffer.from(encoded.split(',')[1], 'base64')).metadata()).width, 40);
  assert.deepEqual(webp, original);
  await assert.rejects(encodeZaicoPhoto(Buffer.from('<html>error</html>')), /形式/);
});
