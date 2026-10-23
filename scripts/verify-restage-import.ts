import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {lotQuantity,purchaseUnitPrice,classifyItem,parseRestageLots,restageInventoryFields,assertAuctionDate,validateImageUrl} from '../lib/procurement/restage';
import {RestageHttp} from '../lib/procurement/restageHttp';
async function main(){
let checks=0;const test=(name:string,fn:()=>void)=>{fn();checks++;console.log('PASS '+name);};
test('通常4台は落札単価×1.188（4で割らない）',()=>assert.equal(purchaseUnitPrice(7000,4,false),8316));
test('一山3点は総額を3で割り切り上げる',()=>assert.equal(purchaseUnitPrice(1001,3,true),397));
test('整数円の計算に浮動小数の誤差が出ない',()=>{for(let n=1;n<20000;n++)assert.equal(purchaseUnitPrice(n,1,false),Number((BigInt(n)*1188n+999n)/1000n));});
test('全角・カンマ付きの一山点数を優先',()=>assert.deepEqual(lotQuantity('家具 １２点 一山','1式'),{quantity:12,isBundle:true,unit:'点'}));
test('実際の3点山・1山表記を3点として計算',()=>assert.deepEqual(lotQuantity('C-3【3点山】ラウンジチェア','1山'),{quantity:3,isBundle:true,unit:'点'}));
test('通常の脚数と台数',()=>{assert.equal(lotQuantity('椅子','4脚').quantity,4);assert.equal(lotQuantity('机','3台').quantity,3);});
test('一山の点数不明は登録を止める',()=>assert.throws(()=>lotQuantity('家具一山','1式')));
test('数量0や価格不明は登録を止める',()=>{assert.throws(()=>lotQuantity('机','0台'));assert.throws(()=>purchaseUnitPrice(0,1,false));});
test('品目は家具4種類とその他',()=>{assert.equal(classifyItem('ローテーブル Knoll'),'テーブル');assert.equal(classifyItem('ハイスツール HAY'),'椅子');assert.equal(classifyItem('サイドボード 木製'),'棚');assert.equal(classifyItem('テーブルランプ'),'照明');assert.equal(classifyItem('冷蔵庫'),'その他');assert.equal(classifyItem('テーブル・椅子 一山'),'その他');});
test('画像は同じ商品IDの1枚目に限定',()=>{assert.throws(()=>validateImageUrl('https://example.com/1.png','123'));assert.throws(()=>validateImageUrl('./common.action?action=get_image&imageKey=999/1.png','123'));});
test('不正日付・未来日は拒否',()=>{assert.throws(()=>assertAuctionDate('2026-02-30'));assert.throws(()=>assertAuctionDate('2099-01-01'));});
const html=await readFile('scripts/fixtures/restage-wins.html','utf8');
const parsed=parseRestageLots(html,'2026-10-23');
test('実際の自社落札11件をすべて読み取る',()=>{assert.equal(parsed.lots.length,11);assert.equal(parsed.errors.length,0);assert.equal(parsed.maxPage,1);});
test('ワンチャンス成立の一山も総額を点数で割る',()=>{const bundle=parsed.lots.find(l=>l.goodsId==='178392')!;assert.equal(bundle.quantity,3);assert.equal(bundle.hammerPrice,3000);assert.equal(bundle.purchasePrice,1188);assert.equal(bundle.isBundle,true);});
test('画面と数量・落札額・購入単価が一致',()=>{const table=parsed.lots.find(l=>l.goodsId==='179580')!;assert.equal(table.name,'A-1 ローテーブル Knoll トボガン プルアップ');assert.equal(table.quantity,4);assert.equal(table.hammerPrice,7000);assert.equal(table.purchasePrice,8316);});
test('仕入・古物台帳の指定項目が揃う',()=>{const v=restageInventoryFields(parsed.lots[0]);assert.equal(v.transactionDate,'2026-10-23');assert.equal(v.transactionType,'買受');assert.equal(v.counterpartyName,'リステージオークション');assert.equal(v.counterpartyAddress,'履歴あり');assert.equal(v.purchaseQuantity,parsed.lots[0].quantity);});
test('自社落札の絞込が外れたHTMLを拒否',()=>assert.throws(()=>parseRestageLots(html.replace('name="listCbn" value="5"','name="listCbn" value="0"'),'2026-10-23')));
test('開催日が違う応答を拒否',()=>assert.throws(()=>parseRestageLots(html,'2026-10-16')));
test('壊れた商品は他の商品へ金額をずらさない',()=>{const x=parseRestageLots(html.replace('7,000円','未確定'),'2026-10-23');assert.equal(x.errors.length,1);assert.equal(x.lots.length,10);});
if(process.argv.includes('--live')){
 const {SecretsManagerClient,GetSecretValueCommand}=await import('@aws-sdk/client-secrets-manager');const {fromIni}=await import('@aws-sdk/credential-providers');
 const secret=await new SecretsManagerClient({region:'us-west-2',credentials:fromIni({profile:'Bello'})}).send(new GetSecretValueCommand({SecretId:'bello/restage-readonly-credentials'}));const client=new RestageHttp(JSON.parse(secret.SecretString!));await client.login();const live=await client.fetchLots('2026-10-23');assert.equal(live.lots.length,11);assert.equal(live.errors.length,0);
 const image=await client.image(live.lots.find(l=>l.goodsId==='179580')!);const sharp=(await import('sharp')).default;const meta=await sharp(image.bytes).metadata();assert(meta.width&&meta.width>=300);console.log(JSON.stringify({liveLogin:true,selfWonCount:live.lots.length,firstPhoto:{mime:image.mime,width:meta.width,height:meta.height,bytes:image.bytes.length}}));
}
console.log(`${checks} checks passed`);
}
main().catch(e=>{console.error(e instanceof Error?e.message:'verification failed');process.exitCode=1;});
