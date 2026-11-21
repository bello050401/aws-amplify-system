import type { CatalogGrant, PublicCatalogItem } from '../../lib/inventory/partnerCatalog/types';

export const candidates: PublicCatalogItem[] = [
  ['ヴィンテージ オーク材 ダイニングチェア 張り地はグレージュ・アーム付きのゆったりとした一脚（長い商品名も全文を確認）', 'repair', '補修待ち'],
  ['ウォールナット サイドボード', 'photo', '撮影待ち'],
  ['ソファ 2シーター', 'listing', '出品待ち'],
  ['ラウンドテーブル', 'repair', '補修待ち'],
  ['写真準備中のラウンジチェア', 'photo', '撮影待ち'],
  ['サイドテーブル', 'listing', '出品待ち'],
].map(([name, stage, stageLabel], index) => ({ id: 'qa-item-'+index, name, managementNumber: 'QA-BELLO-'+(100+index), quantity: index+1,
  dimensions: { width: index===4?null:'80', depth:'50', height:'75' }, stage:stage as PublicCatalogItem['stage'], stageLabel:stageLabel as PublicCatalogItem['stageLabel'],
  imageUrl:index===4?null:'/fixture-furniture.svg', images:index===4?[]:['/fixture-furniture.svg','/fixture-detail.svg'] }));
type State = {grants: CatalogGrant[]; nextFailure: 'none'|'unavailable'|'conflict'};
const stateKey = Symbol.for('BELLO.private.catalog-selection-preview');
const scope=globalThis as unknown as {[stateKey]:State};
export function state():State {
  if(!scope[stateKey]) scope[stateKey]={grants:[{id:'7146b25b-4fc8-4e35-80e4-c49b10e72aa5',label:'選択共有の確認用',title:'BELLO 商品カタログ（確認用）',createdAt:'2026-11-21T00:00:00Z',updatedAt:'2026-11-21T00:00:00Z',expiresAt:'2027-02-19T00:00:00Z',disabled:false,path:'/share/inventory/selecteddemo',revision:1,selectedIds:[]}],nextFailure:'none'};
  return scope[stateKey];
}
