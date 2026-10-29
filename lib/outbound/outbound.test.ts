import assert from 'node:assert/strict';
import {test} from 'node:test';
import {outboundStatusLabel,outboundRowLabel,outboundCsv,exportProductName,type OutboundRow} from './types';
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

test('在庫数メモは送信名だけから除き、商品条件や数字は残す',()=>{
 for(const memo of ['【在庫4】','【在庫４】','【 在庫：４ 脚 】','【在庫1,000個】']){
  const row={name:memo+' MARUNI Table 135 【天板傷】'};
  assert.equal(exportProductName(row),'MARUNI Table 135 【天板傷】');
  assert.equal(row.name,memo+' MARUNI Table 135 【天板傷】');
 }
 assert.equal(exportProductName({name:'商品A【在庫3】'}),'商品A');
 assert.equal(exportProductName({name:'【在庫確認中】商品A【2点セット】'}),'【在庫確認中】商品A【2点セット】');
 assert.equal(exportProductName({name:'元の商品名',exportName:'【在庫２点】送信用の商品名'}),'送信用の商品名');
 assert.equal(exportProductName({name:'【在庫4】'}),'');
 const csv=outboundCsv([{name:'【在庫4】テーブル',quantity:3} as never],[{key:'name',label:'商品名'},{key:'quantity',label:'数量'}]);
 assert.ok(csv.includes('"テーブル","3"'));assert.ok(!csv.includes('在庫'));
});
