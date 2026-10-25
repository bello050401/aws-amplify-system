import assert from 'node:assert/strict';
import {runEconveniCommand} from '../lib/listing/econveni/commandWorkflow';
import {initialEconveniWorkflow,type EconveniWorkflow} from '../lib/listing/econveni/workflowStore';
import {EconveniHttpError,type EconveniRemoteProduct,type EconveniCommand} from '../lib/listing/econveni/httpSession';
async function main(){
 const input={inventoryId:'inventory-test-one',channel:'YAHOO' as const,operation:'PUBLISH' as const,fingerprint:'hash',title:'owned test',price:999999};
 let current:EconveniWorkflow={...initialEconveniWorkflow(input.inventoryId),save:{state:'SUCCEEDED',productId:'123',fingerprint:'hash'}};
 let observed:EconveniRemoteProduct={productId:'123',url:'https://smart.e-conveni.net/product.php?action=product_update&products_id=123',operationId:'save',channels:{YAHOO:{state:'INACTIVE',listingId:null,listingUrl:null},MERCARI_SHOPS:{state:'INACTIVE',listingId:null,listingUrl:null}}};
 const commands:string[]=[];let crashReservation=false,crashResult=false,uncertainSend=false;
 const store={read:async()=>current,stop:async(reason:string)=>{commands.push('halt:'+reason);},commit:async(before:EconveniWorkflow|null,next:EconveniWorkflow,reserve=false)=>{
   if(reserve&&crashReservation)throw Error('DDB unavailable');
   if(!reserve&&crashResult)throw Error('DDB unavailable');
   current={...next,revision:(before?.revision??0)+1};commands.push(reserve?'reserved':'result');return current;
 }};
 const session={readInventory:async()=>observed,publicationPreview:async()=>({...input,productId:'123',accountId:'9350',url:'https://smart.e-conveni.net/yahoo_submit.php'} as EconveniCommand),executeCommand:async()=>{
   commands.push('send');assert.equal(current.channels.YAHOO.state,'PENDING','Reserve must exist before external write');
   if(uncertainSend)throw new EconveniHttpError('NETWORK');
   observed={...observed,channels:{...observed.channels,YAHOO:{state:'ACTIVE',listingId:'s123',listingUrl:'https://auctions.yahoo.co.jp/jp/auction/s123'}}};return {html:'normal result',status:200,url:'https://smart.e-conveni.net/yahoo_submit.php'};
 }};
 crashReservation=true;await assert.rejects(runEconveniCommand(store,session,input));assert.equal(commands.includes('send'),false);
 crashReservation=false;uncertainSend=true;const pending=await runEconveniCommand(store,session,input);assert.equal(pending.channels.YAHOO.state,'VERIFY_REQUIRED');assert.deepEqual(commands,['reserved','send','result']);
 await runEconveniCommand(store,session,input);assert.equal(commands.filter(c=>c==='send').length,1,'No blind resend after timeout');
 observed={...observed,channels:{...observed.channels,YAHOO:{state:'ACTIVE',listingId:'s123',listingUrl:'https://auctions.yahoo.co.jp/jp/auction/s123'}}};
 assert.equal((await runEconveniCommand(store,session,input)).channels.YAHOO.state,'SUCCEEDED');
 await runEconveniCommand(store,session,input);assert.equal(commands.filter(c=>c==='send').length,1);
 current={...current,channels:{...current.channels,MERCARI_SHOPS:{state:'SUCCEEDED',remoteStatus:'ACTIVE',listingId:'shops123'}}};
 const beforeRemoval=commands.length;
 await assert.rejects(runEconveniCommand(store,session,{...input,channel:'MERCARI_SHOPS',operation:'STOP'}),/REMOVAL_NOT_AUTHORIZED/);
 assert.equal(commands.length,beforeRemoval,'A normal stop request must not reserve or execute product deletion');
 console.log('PASS: reservation failure sends nothing, command follows durable reservation, timeout only reconciles, public result recovers without retry, successful channel never republishes');
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
