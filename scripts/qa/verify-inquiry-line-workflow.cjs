const assert=require('node:assert/strict'),esbuild=require('esbuild'),vm=require('node:vm'),path=require('node:path');
let passes=0;function check(name,fn){fn();passes++;console.log('PASS '+name);}
(async()=>{
 const sandbox={module:{exports:{}},exports:{},require,process:{env:{}},console,URL,setTimeout,clearTimeout};
 const built=await esbuild.build({stdin:{contents:'export {extractQuantity,resolveNegotiationContext} from "./lib/inquiry/negotiation"; export * from "./lib/inquiry/paymentWorkflow"; export {confirmedBaseBinding} from "./lib/inquiry/listingBindings"; export {shouldUseBaseMock,isProductionRuntime} from "./lib/base/connectionState";export {decideResolution} from "./lib/inquiry/scoring";',loader:'ts',resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',write:false,packages:'external',plugins:[{name:'no-io',setup(b){b.onResolve({filter:/^server-only$|categoryPersistence$|\/oauth$|\/secretStore$|writeGuard$|e2eFixtures$/},a=>({path:a.path,namespace:'noio'}));b.onLoad({filter:/.*/,namespace:'noio'},()=>({contents:'export const inventoryDdb={};export const isBaseConnected=()=>false;export const getBaseCredentialsState=()=>({});export const isExternalWriteEnabled=()=>false;export const isE2EFixtureModeActive=()=>false;',loader:'js'}));}}]});vm.runInNewContext(built.outputFiles[0].text,sandbox);const f=sandbox.module.exports;
 const noCounts=['以下の2点ご回答ください','質問が2つあります','二点について質問です','1点確認したいです','質問は3個あります','確認事項2点','サイズは幅60cmです'];
 for(const text of noCounts)check('question/dimension is not quantity: '+text,()=>assert.equal(f.extractQuantity(text),null));
 for(const [text,q] of [['2脚で6万円',2],['3点購入したい',3],['2セット購入',2],['二台まとめて',2],['以下の2点ご回答ください。椅子3脚購入します',3]])check('purchase quantity: '+text,()=>assert.equal(f.extractQuantity(text).value,q));
 const follow=f.resolveNegotiationContext({currentText:'配送先は東京都国立市です。お値下げ頂けるなら銀行振込で構いません。',currentHasDestination:true,history:[{direction:'INBOUND',body:'以下の2点ご回答ください。55,800円までお値下げ可能でしょうか？'}]});
 check('follow-up retains requested total without question count',()=>{assert.equal(follow.requestedTotalPriceYen,55800);assert.equal(follow.requestedUnitPriceYen,55800);assert.equal(follow.quantity,null);});
 const fresh=f.resolveNegotiationContext({currentText:'https://example.org/next 2脚で6万円まで値下げできますか？東京都です',currentHasDestination:true,history:[{direction:'INBOUND',body:'3点で9万円まで値下げ可能ですか'}]});
 check('new product does not inherit earlier quantity/price',()=>{assert.equal(fresh.quantity,2);assert.equal(fresh.requestedTotalPriceYen,60000);});
 const env=sandbox.process.env;const clear=()=>{for(const k of Object.keys(env))delete env[k];};
 for(const [marker,value] of [['NODE_ENV','production'],['AWS_LAMBDA_FUNCTION_NAME','worker'],['AWS_EXECUTION_ENV','AWS_Lambda_nodejs22.x'],['INQUIRY_TABLE','inbox']])check('cloud always uses real BASE: '+marker,()=>{clear();env[marker]=value;env.BASE_USE_MOCK='true';assert.equal(f.shouldUseBaseMock(),false);});
 check('explicit local mock still available',()=>{clear();env.BASE_USE_MOCK='true';assert.equal(f.shouldUseBaseMock(),true);});
 check('local real credentials select real client',()=>{clear();env.BASE_CLIENT_ID='test';env.BASE_CLIENT_SECRET='test';assert.equal(f.shouldUseBaseMock(),false);});
 const original='ご希望の金額で対応できるか確認いたします。',out=f.ensureOfficialLinePaymentGuidance(original,'LINE',true);
 check('LINE workflow contains invoice and bank transfer even with missing price',()=>{assert.match(out,/公式LINE.*請求書/);assert.match(out,/銀行振込/);assert.doesNotMatch(out,/発行しました|送付済み|入金済み/);});
 check('workflow is not duplicated',()=>assert.equal(f.ensureOfficialLinePaymentGuidance(out,'LINE',true),out));
 for(const channel of ['MERCARI_SHOPS','BASE','YAHOO'])check('no unauthorized off-platform direction: '+channel,()=>assert.equal(f.ensureOfficialLinePaymentGuidance(original,channel,true),original));
 check('non-negotiation stays unchanged',()=>assert.equal(f.ensureOfficialLinePaymentGuidance(original,'LINE',false),original));
 const row={pk:'ECONVENI#MANUAL_LINK#inv-a',inventoryId:'inv-a',linkedAt:'2026-10-25',productId:'remote-a',baseline:{BASE:{listingId:'157908850'}}};
 check('confirmed exact BASE binding recognized',()=>assert.equal(f.confirmedBaseBinding(row,'inv-a',['157908850']),true));
 for(const altered of [{...row,inventoryId:'inv-b'},{...row,linkedAt:null},{...row,baseline:{BASE:{listingId:'another'}}},undefined])check('no wrong/missing binding confirmation',()=>assert.equal(f.confirmedBaseBinding(altered,'inv-a',['157908850']),false));
 check('matching title alone stays unconfirmed',()=>assert.equal(f.decideResolution([{inventoryId:'a',confidence:.92}]).status,'AMBIGUOUS'));
 check('two linked physical stocks stay ambiguous',()=>assert.equal(f.decideResolution([{inventoryId:'a',confidence:1},{inventoryId:'b',confidence:1}]).status,'AMBIGUOUS'));
 console.log(JSON.stringify({passed:passes,externalWrites:0,customerSends:0}));
})().catch(e=>{console.error(e);process.exitCode=1;});
