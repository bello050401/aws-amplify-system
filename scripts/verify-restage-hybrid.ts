import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {lotQuantity,parseRestageLots,completeRestageDraft} from '../lib/procurement/restage';
import {restageLedger} from '../lib/procurement/restageLedger';
async function main(){
  let checks=0;const test=(name:string,fn:()=>void)=>{fn();checks++;console.log('PASS '+name);};
  for(const [name,count,unit] of [['【5脚山】スタックチェア arper Catifa46',5,'脚'],['【５脚山】チェア',5,'脚'],['【12台一山】机',12,'台'],['【3個山】',3,'個'],['4枚まとめて一山',4,'枚'],['【2本山】',2,'本'],['【6点山】',6,'点']] as const){
    test(name,()=>assert.deepEqual(lotQuantity(name,'1山'),{quantity:count,isBundle:true,unit}));
  }
  test('元の数量欄が5脚山でも認識',()=>assert.equal(lotQuantity('椅子','5脚山').quantity,5));
  test('単なる1山は1点と誤認しない',()=>assert.throws(()=>lotQuantity('椅子一山','1山')));
  test('矛盾する一山数量は手入力へ',()=>assert.throws(()=>lotQuantity('【5脚山】椅子','4脚山')));
  const html=await readFile('scripts/fixtures/restage-wins.html','utf8');
  const broken=parseRestageLots(html.replace('C-3【3点山】','C-3【一山】').replace('7,000円','未確定'),'2026-10-23');
  test('数量と価格不明でも全11商品の情報を保持',()=>{assert.equal(broken.drafts.length,11);assert.equal(broken.errors.length,0);assert.equal(broken.drafts.filter(x=>x.quantity===null).length,1);assert.equal(broken.drafts.filter(x=>x.hammerPrice===null).length,1);});
  const unknown=broken.drafts.find(x=>x.quantity===null)!;
  test('不明な数量は勝手に1に補完しない',()=>assert.throws(()=>completeRestageDraft(unknown)));
  const completed=broken.drafts.map(d=>completeRestageDraft(d,{...d,quantity:d.quantity??5,hammerPrice:d.hammerPrice??7000}));
  test('補完すると一山単価と開催日全体の台帳を再計算',()=>{assert.equal(completed.find(d=>d.goodsId===unknown.goodsId)!.purchasePrice,713);assert.equal(restageLedger(completed).quantity,39);assert.equal(restageLedger(completed).purchaseTotal,250668);});
  test('不正な入力、0、負数、小数を拒否',()=>{for(const quantity of [null,0,-1,1.1,100001,NaN])assert.throws(()=>completeRestageDraft(unknown,{...unknown,quantity}));for(const hammerPrice of [null,0,-1,1.1,100000001,NaN])assert.throws(()=>completeRestageDraft(unknown,{...unknown,quantity:5,hammerPrice}));});
  test('クライアントの任意URL・ID・購入単価は採用しない',()=>{const result=completeRestageDraft(unknown,{...unknown,quantity:5,imageUrl:'https://bad.invalid',purchasePrice:1,date:'2000-01-01'} as never);assert.equal(result.imageUrl,unknown.imageUrl);assert.equal(result.date,unknown.date);assert.equal(result.purchasePrice,713);assert.throws(()=>completeRestageDraft(unknown,{...unknown,goodsId:'999',quantity:5}));});
  test('商品ID・開催日の異常は補完対象にしない',()=>{const invalid=parseRestageLots(html.replaceAll('179580','invalid'),'2026-10-23');assert.equal(invalid.errors.length,1);assert(!invalid.drafts.some(d=>d.goodsId==='invalid'));});
  console.log(`${checks} hybrid checks passed`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});

