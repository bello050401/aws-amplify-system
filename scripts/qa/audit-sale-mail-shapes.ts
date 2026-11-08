import {purchaseGmailReader} from '../../lib/saleCandidates/mailReader';
import {parsePurchaseMail} from '../../lib/saleCandidates/mailParser';
import {writeFileSync} from 'node:fs';
async function main(){
 const gmail=await purchaseGmailReader(),reports=[];
 for(const query of ['from:auction-master@mail.yahoo.co.jp newer_than:30d','from:mercari-shops.com newer_than:30d (キャンセル OR 購入)']){
  const page=await gmail.list(query),mails=page.messages??[];const rows:{type:string;authenticated:boolean;parsed:number;quantityKnown:boolean;shippingKnown:boolean;hasItemId:boolean;hasAmount:boolean}[]=[];
  for(const m of mails.slice(0,40)){const mail=await gmail.read(m.id),c=parsePurchaseMail(mail),prefix=mail.subject.split(/[:：]/)[0];
   rows.push({type:/キャンセル|取消|取り消|削除/.test(prefix)?'CANCELLATION':/支払/.test(prefix)?'PAYMENT':/住所確定/.test(prefix)?'ADDRESS':/落札|購入/.test(prefix)?'ORDER':'OTHER',authenticated:!!(mail.authenticatedYahooSender||mail.authenticatedMercariSender),parsed:c.length,quantityKnown:c.some(x=>x.quantity!==null),shippingKnown:c.some(x=>x.shipping!==null),hasItemId:c.some(x=>!!x.externalListingId),hasAmount:c.some(x=>x.unitPrice!==null)});
  }
  const count=(field:string)=>rows.filter(r=>(r as Record<string,unknown>)[field]).length;
  reports.push({source:query.startsWith('from:auction')?'YAHOO':'MERCARI',checked:rows.length,more:!!page.nextPageToken,types:rows.reduce((a,r)=>(a[r.type]=(a[r.type]??0)+1,a),{} as Record<string,number>),authenticated:count('authenticated'),parsed:count('parsed'),quantityKnown:count('quantityKnown'),shippingKnown:count('shippingKnown'),hasItemId:count('hasItemId'),hasAmount:count('hasAmount')});
 }
 writeFileSync('artifacts/sale-automation-20261108/mail-format-audit.json',JSON.stringify({at:new Date().toISOString(),reports},null,2));console.log(JSON.stringify(reports));
}
main().catch(e=>{console.error((e as Error).message);process.exitCode=1;});
