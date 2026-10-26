import assert from 'node:assert/strict';
import {titleSimilarity,titleWithoutNotes,sameTitleWithoutNotes,differentTitleNotes,productTitleMatchesQuery} from '../lib/listing/econveni/manualSyncModel';

let passed=0;
function test(name:string,run:()=>void){run();console.log('PASS '+name);passed++;}

test('prefix internal memo does not lower a real title match',()=>{
 assert.equal(titleSimilarity('【天板傷・補修必要】Vitra Belleville Table','Vitra Belleville Table'),1);
});
test('multiple and inline memos are ignored on either side',()=>{
 assert.equal(titleSimilarity('【店内用】Vitra【右後脚キズ】Belleville Table【確認済】','Vitra Belleville Table【担当者メモ】'),1);
});
test('all bracket contents are memos as instructed, never automatically bound',()=>{
 assert.equal(titleSimilarity('【2点セット】【ブラック】椅子A','【3点セット】【ホワイト】椅子A'),1);
 assert.equal(differentTitleNotes('【2点セット】椅子A','【3点セット】椅子A'),true);
});
test('same memo cannot make different products match',()=>{
 const title='【天板キズ・補修要】Vitra Belleville';
 assert.ok(titleSimilarity(title,'Vitra Belleville')>titleSimilarity(title,'【天板キズ・補修要】Cassina CAB'));
 assert.equal(sameTitleWithoutNotes(title,'【天板キズ・補修要】Cassina CAB'),false);
});
test('model and ordinary parentheses remain significant',()=>{
 assert.ok(titleSimilarity('【確認】Cassina CAB 413 ブラック','Cassina CAB 414 ブラック')<1);
 assert.equal(titleWithoutNotes('【確認】椅子A（ブラック）'),'椅子A（ブラック）');
});
test('empty and memo-only names never become identical candidates',()=>{
 for(const left of ['','【補修待ち】','【】','  ']){
  assert.equal(titleSimilarity(left,'【補修待ち】'),0);
  assert.equal(sameTitleWithoutNotes(left,'【補修待ち】'),false);
 }
});
test('unclosed bracket does not delete an unknown part of the product name',()=>{
 assert.equal(titleWithoutNotes('椅子A【脚に傷'),'椅子A【脚に傷');
 assert.equal(titleWithoutNotes('椅子A】'),'椅子A】');
});
test('width and punctuation normalization remains supported',()=>{
 assert.equal(titleSimilarity('【確認】Ａ　椅子①','a 椅子1'),1);
});
test('paste BELLO title with memo into remote search',()=>{
 assert.equal(productTitleMatchesQuery('Vitra Belleville Table','123','【天板傷】Vitra Belleville Table'),true);
});
test('search across a memo in the middle of a BELLO title',()=>{
 assert.equal(productTitleMatchesQuery('Vitra【店内メモ】Belleville Table','B001','Vitra Belleville'),true);
});
test('memo-only searches remain explicit and do not match every product',()=>{
 assert.equal(productTitleMatchesQuery('【天板傷】テーブル','123','【天板傷】'),true);
 assert.equal(productTitleMatchesQuery('傷なしテーブル','123','【天板傷】'),false);
 assert.equal(productTitleMatchesQuery('テーブル','123','【】'),false);
 assert.equal(productTitleMatchesQuery('テーブル','123','!!!'),false);
});
test('identifier and blank queries preserve normal search',()=>{
 assert.equal(productTitleMatchesQuery('テーブル','B001','ｂ００１'),true);
 assert.equal(productTitleMatchesQuery('テーブル','123','123'),true);
 assert.equal(productTitleMatchesQuery('テーブル','123','   '),true);
 assert.equal(productTitleMatchesQuery('テーブル','123','ソファ'),false);
});
test('memo differences are indicated without changing originals',()=>{
 const a='【補修要】椅子A',b='椅子A';
 assert.equal(differentTitleNotes(a,b),true);
 assert.equal(differentTitleNotes('【点検】【補修要】椅子A','【補修要】【点検】椅子A'),false);
 titleSimilarity(a,b);productTitleMatchesQuery(a,'123',b);
 assert.equal(a,'【補修要】椅子A');assert.equal(b,'椅子A');
});
console.log(`TOTAL ${passed} passed`);
