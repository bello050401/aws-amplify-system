import assert from 'node:assert/strict';
import {test} from 'node:test';
import {outboundStatusLabel,outboundRowLabel,outboundCsv,type OutboundRow} from './types';
import {outboundThumbnailFields} from './productThumbnail';
import type {RawInventoryImage} from '@/lib/inventory/imageTypes';
test('送信後の更新失敗を未送信と案内しない',()=>{
 for(const state of ['PARTIAL','APPLYING']){
  assert(!outboundStatusLabel(state).includes('送信待ち'));
  assert.match(outboundRowLabel({status:'PENDING'} as OutboundRow,state),/送信記録済み/);
 }
 assert.equal(outboundStatusLabel('AWAITING_SEND'),'送信待ち');
 assert.equal(outboundStatusLabel('UNKNOWN'),'状態を確認してください');
});
test('出庫画像は傷写真を除外し、順序と明示したメイン指定を維持する',()=>{
 const images:(RawInventoryImage|null)[]=[{storageKey:'damage',type:'DAMAGE',isPrimary:true,sortOrder:0},null,{storageKey:'second',sortOrder:2},{storageKey:'normal',sortOrder:1,thumbnailKey:'thumb'}];
 assert.deepEqual(outboundThumbnailFields(images),{mainImageStorageKey:'normal',mainImageThumbnailKey:'thumb',mainImageIsPrimary:false});
 images[2]={storageKey:'second',isPrimary:true,sortOrder:2};
 assert.deepEqual(outboundThumbnailFields(images),{mainImageStorageKey:'second',mainImageThumbnailKey:'second',mainImageIsPrimary:true});
 assert.equal(outboundThumbnailFields([images[0]]).mainImageStorageKey,null);
});
test('CSVの改行と引用符を保持し、式として解釈される商品名を無効化する',()=>{
 const csv=outboundCsv([{name:'=HYPERLINK("test")\n商品'} as never],[{key:'name',label:'商品名'}]);
 assert(csv.startsWith('\ufeff'));assert(csv.includes('"\'=HYPERLINK(""test"")\n商品"'));
});
