import assert from "node:assert/strict";
import {parseYahooQuestionMail, trustedYahooQuestionNotification, yahooAuctionIdFromUrl, yahooQuestionUrl} from "../lib/messaging/yahoo/questionMailParser";
import {ingestYahooQuestionMail, type YahooQuestionPorts} from "../lib/messaging/yahoo/questionMailIngest";
import {redactInquiryContacts} from "../lib/messaging/contactPrivacy";
import {normalizeUrl} from "../lib/inquiry/references";
import {scoreInventory, type MatchableInventory, type MatchSignals} from "../lib/inquiry/scoring";
import {parseYahooMail} from "../lib/saleCandidates/yahooMail";
import type {FetchedMail} from "../lib/messaging/email/gmailClient";

const question = "①布地？レザータイプ？ですか?\n②東京都世田谷区までの送料教えて下さい。お手数ですが宜しくお願いします。";
const sample = `Belloインテリア様
出品中の商品について、ind********さんから11月 13日 11時 33分に質問が届きました。
1. オークション情報
商品：arper Colina ラウンジチェア / アルペール コリーナ
オークションID：q1249691645
オークションURL：https://auctions.yahoo.co.jp/jp/auction/q1249691645
2. 質問への回答
質問の内容：
　「${question}」
この質問に回答するには、出品時のYahoo! JAPAN IDでログインして、下記URLにアクセスしてください。
https://auctions.yahoo.co.jp/jp/show/qanda?aID=q1249691645
フォームに回答を入力し、「送信」をクリックしてください。`;
const mail:FetchedMail={gmailId:"test-yahoo-question-1",messageId:"<test@example.invalid>",subject:"Yahoo!オークション - 質問：arper Colina (q1249691645)",text:sample,html:"",from:"Yahoo!オークション <auction-master@mail.yahoo.co.jp>",receivedAt:"2026-11-13T02:33:41.000Z"};
let checks=0;
function test(name:string,run:()=>void){run();checks++;console.log("PASS "+name);}
test("提示メールの質問2件・商品ID・商品名・質問者を抽出",()=>{
  const p=parseYahooQuestionMail(mail)!;assert.equal(p.status,"PARSED");assert.equal(p.messageText,question);assert.equal(p.auctionId,"q1249691645");assert.equal(p.questioner,"ind********");assert(p.productName?.startsWith("arper"));
  assert(!p.messageText?.includes("送信」をクリック"));
});
test("HTMLのみ・改行・全角コロンにも対応",()=>{
 const p=parseYahooQuestionMail({...mail,text:"",html:"<div>"+sample.replace(/\n/g,"<br>")+"</div>"})!;
 assert.equal(p.messageText,question);assert.equal(p.auctionId,"q1249691645");
 assert.equal(parseYahooQuestionMail({...mail,text:sample.replace(/\n/g,"\r\n")})?.status,"PARSED");
});
test("落札・入金メールは問い合わせに登録しない／質問は売却しない",()=>{
 assert.equal(parseYahooQuestionMail({...mail,subject:"即決価格での落札：チェア",text:"商品が即決価格で落札されました。"}),null);
 assert.deepEqual(parseYahooMail(mail,sample),[]);
});
test("本文欠落・ID競合・ID欠落は要確認、勝手に補完しない",()=>{
 assert.equal(parseYahooQuestionMail({...mail,text:sample.replace(question,"")})?.status,"PARSE_FAILED");
 assert.equal(parseYahooQuestionMail({...mail,text:sample.replace("aID=q1249691645","aID=q9999999999")})?.auctionId,null);
 assert.equal(parseYahooQuestionMail({...mail,text:sample.replaceAll("q1249691645","invalid")})?.status,"PARSE_FAILED");
 assert.equal(parseYahooQuestionMail({...mail,text:"通知形式が変わった場合"})?.status,"PARSE_FAILED");
});
test("顧客本文の別商品URLを通知のIDと混同しない",()=>{
 const p=parseYahooQuestionMail({...mail,text:sample.replace(question,question+" https://auctions.yahoo.co.jp/jp/auction/a1234567890")})!;
 assert.equal(p.auctionId,"q1249691645");
});
test("Gmail認証・送信元・迷惑メール判定を維持",()=>{
 const trusted={from:mail.from,authenticationResults:"mx.google.com; dmarc=pass header.from=mail.yahoo.co.jp",labels:["INBOX"]};
 assert(trustedYahooQuestionNotification(trusted));
 for(const patch of [{from:"attacker@example.invalid"}, {authenticationResults:"mx.other.com; dmarc=pass header.from=mail.yahoo.co.jp"}, {authenticationResults:"mx.google.com; dmarc=fail header.from=mail.yahoo.co.jp"}, {labels:["SPAM"]}, {labels:["SENT"]}])assert(!trustedYahooQuestionNotification({...trusted,...patch}));
});
test("回答URLを限定し、Yahooの旧URL表記にも対応",()=>{
 assert.equal(yahooAuctionIdFromUrl("https://page22.auctions.yahoo.co.jp/jp/auction/q1249691645"),"q1249691645");
 assert.equal(yahooAuctionIdFromUrl("https://auctions.yahoo.co.jp.evil.invalid/jp/auction/q1249691645"),null);
 assert.equal(yahooQuestionUrl("javascript:alert(1)"),null);
 assert.equal(normalizeUrl("http://page.auctions.yahoo.co.jp/jp/auction/q1249691645?x=1"),normalizeUrl("https://auctions.yahoo.co.jp/jp/auction/q1249691645"));
});
test("オークションIDでURL未登録の商品も照合、別販路IDは流用しない",()=>{
 const inv:MatchableInventory={id:"i1",name:"社内名",sku:"B000001",displayInventoryId:"1",externalProductId:null,barcode:null,sourceInventoryId:null,listings:[{channel:"YAHOO_AUCTION",externalListingId:"q1249691645",listingUrl:null}]};
 const signals:MatchSignals={normalizedUrls:["https://auctions.yahoo.co.jp/jp/auction/q1249691645"],baseItemIds:[],skus:[],inventoryIds:[],modelNumbers:[],brandNames:[],nameFragments:[]};
 assert.equal(scoreInventory(inv,signals).confidence,0.98);
 assert.equal(scoreInventory({...inv,listings:[{...inv.listings[0],channel:"BASE"}]},signals).confidence,0);
});
test("保存時の住所削除方針を維持、都道府県は残す",()=>{
 const sanitized=redactInquiryContacts(question);assert(sanitized.includes("東京都"));assert(!sanitized.includes("世田谷区"));assert(sanitized.includes("布地"));
});
async function main(){
 const records=new Map<string,{conversationId:string;messageId:string}>();
 const queued=new Map<string,unknown>();const conversationKeys=new Set<string>();let failQueue=false;
 const ports:YahooQuestionPorts={
  record:async p=>{conversationKeys.add(p.externalConversationId!);let r=records.get(p.externalMessageId);if(r)return {...r,deduped:true};r={conversationId:"c"+records.size,messageId:"m"+records.size};records.set(p.externalMessageId,r);return r;},
  enqueue:async (_channel,_account,_conversation,id,payload)=>{if(failQueue){failQueue=false;throw Error("simulated queue outage");}queued.set(id,payload);return "scope";}
 };
 await ingestYahooQuestionMail(mail,{who:null,mailbox:"qa"},ports);
 await ingestYahooQuestionMail(mail,{who:null,mailbox:"qa"},ports);
 assert.equal(records.size,1);assert.equal(queued.size,1);checks++;console.log("PASS 同じGmail IDの再取得は重複しない");
 failQueue=true;
 await assert.rejects(ingestYahooQuestionMail({...mail,gmailId:"second"},{who:null,mailbox:"qa"},ports));
 await ingestYahooQuestionMail({...mail,gmailId:"second"},{who:null,mailbox:"qa"},ports);
 assert.equal(records.size,2);assert.equal(queued.size,2);checks++;console.log("PASS 保存後のキュー失敗を再実行で回復");
 assert.equal(conversationKeys.size,2);checks++;console.log("PASS 同じマスク名・商品でも別の質問を混ぜない");
 for(const value of queued.values()){const p=value as {channel:string;params:{productLookupHint:string;additionalContext:string;mercariInquiryUrl?:string}};assert.equal(p.channel,"YAHOO_AUCTION");assert(p.params.productLookupHint.includes("q1249691645"));assert(!p.params.mercariInquiryUrl);assert(p.params.additionalContext.includes("公開"));}
 console.log(JSON.stringify({passed:checks}));
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
