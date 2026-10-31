import {test} from 'node:test';import assert from 'node:assert/strict';import {productTitleMatchesQuery} from '../lib/listing/econveni/manualSyncModel';
test('separated words, internal notes and external IDs find candidates without automatic binding',()=>{
 assert(productTitleMatchesQuery('J.L.Moller ダイニングテーブル 北欧 オイル仕上げ','10178031 q1250132546','Moller オイル'));
 assert(productTitleMatchesQuery('J.L.Moller ダイニングテーブル','10178031 q1250132546','【在庫5】J.L.Moller ダイニングテーブル'));
 assert(productTitleMatchesQuery('椅子','10178031 q1250132546','q1250132546'));
 assert(!productTitleMatchesQuery('Moller チェア','1','Moller テーブル'));
 assert(!productTitleMatchesQuery('Moller チェア','1','【在庫5】'));
});
