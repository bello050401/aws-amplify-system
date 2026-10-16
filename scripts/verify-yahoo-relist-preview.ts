/** Read-only existing item + non-public preview. Never calls config/submit. */
import fs from 'node:fs/promises';
import {GetSecretValueCommand,SecretsManagerClient} from '@aws-sdk/client-secrets-manager';
import {parse} from 'parse5';
import {YahooWebSession} from '../lib/listing/yahooAuction/webHttpSession';
import {publicationFields} from '../lib/listing/yahooAuction/publicationFields';
async function main(){
  const [harPath,resultPath]=process.argv.slice(2);
  if(!harPath||!resultPath)throw Error();
  const h=JSON.parse(await fs.readFile(harPath,'utf8'));
  const source=h.log.entries.findLast((e:any)=>new URL(e.request.url).pathname==='/sell/jp/show/preview');
  const p=new URLSearchParams(source.request.postData.text);
  const raw=(await new SecretsManagerClient({region:'us-west-2'}).send(new GetSecretValueCommand({SecretId:'bello/yahoo-web-session-staging'}))).SecretString!;
  let responseSummary:unknown=null;
  const nodes=(n:any):any[]=>[n,...(n.childNodes??[]).flatMap(nodes)];
  const attr=(n:any,k:string)=>n.attrs?.find((a:any)=>a.name===k)?.value;
  const s=YahooWebSession.fromStoredSession(raw,{fetchImpl:async(u,o)=>{
    const r=await fetch(u,o);
    if(String(u).endsWith('/show/preview')){
      const n=nodes(parse(await r.clone().text()));
      const form=n.find(n=>n.tagName==='form'&&attr(n,'name')==='auction');
      responseSummary={status:r.status,unknownFields:form?nodes(form).filter(n=>n.tagName==='input'&&attr(n,'name')&&!publicationFields.has(attr(n,'name'))).map(n=>attr(n,'name')):[],fields:n.filter(n=>n.tagName==='input'&&['mode','aID','oldAID','totalCharges','StartPrice','BidOrBuyPrice'].includes(attr(n,'name')))
        .map(n=>({name:attr(n,'name'),value:attr(n,'value')})),button:n.filter(n=>n.tagName==='button'&&attr(n,'id')==='auc_preview_submit_down').map(n=>({action:attr(n,'onclick')}))};
    }
    return r;
  }});
  if(!s.ok)throw Error();
  const result=await s.value.previewFixedListing({title:p.get('Title')!,description:'動作検証用。公開しません。',condition:'used20',priceYen:99999,quantity:1,
    categoryId:p.get('category')!,closingDateJst:new Date(Date.now()+2*86400000+9*3600000).toISOString().slice(0,10),closingHourJst:22,
    relistId:'f1248612637',shipping:{payer:'seller',method:'家財おまかせ便',prefecture:'11',schedule:'2'}},
    {url:p.get('ImageFullPath1')!,width:Number(p.get('ImageWidth1')),height:Number(p.get('ImageHeight1'))});
  const proof={checkedAt:new Date().toISOString(),operation:'RELIST_PREVIEW_ONLY',publicationAttempted:false,result,responseSummary};
  await fs.writeFile(resultPath,JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
}
main().catch(()=>{console.log('{"ok":false,"code":"PREVIEW_CHECK_FAILED"}');process.exitCode=1;});
