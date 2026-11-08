const assert=require('node:assert/strict');
const esbuild=require('esbuild');
const vm=require('node:vm');
const built=esbuild.buildSync({entryPoints:['lib/inquiry/fulfillmentSafety.ts'],bundle:true,platform:'node',format:'cjs',write:false});
const sandbox={exports:{},module:{exports:{}}};vm.runInNewContext(built.outputFiles[0].text,sandbox);
const {detectUnverifiedFulfillment:detect}=sandbox.module.exports;
const blocked=[
 '11月20日金曜日の18時〜21時にお届けするよう手配いたします。',
 '１１月２０日金曜日の１８時～２１時にお届けするよう手配いたします。',
 'ご希望日に配送するよう予約しました。',
 '配送の日時は確定しました。',
 'お届けの予約済みです。',
 '明日発送いたします。',
 '配送会社より確定の時間をお知らせするメールが届きます。',
];
const allowed=[
 'ご希望日時を確認しました。配送会社へ空き状況を確認のうえ、ご案内いたします。',
 'ご希望日時で手配できるか確認します。',
 '配送日時は未確定です。',
 'お届け日時は確定していません。',
 'ご希望のお届け日時は確定できません。',
 'お届けをお約束することはできません。',
 '配送会社からメールが届くかは未確認です。',
 '商品の幅は50cmです。',
];
for(const text of blocked)assert.equal(detect(text).length>0,true,'External commitment must be held');
for(const text of allowed)assert.equal(detect(text).length,0,'Acknowledgment/uncertainty must remain usable');
console.log(JSON.stringify({passed:blocked.length+allowed.length,externalCalls:0}));
