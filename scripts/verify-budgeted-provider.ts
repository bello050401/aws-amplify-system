import assert from 'node:assert/strict';
import { BedrockRuntimeClient, CountTokensCommand, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { NovaGatewayProvider } from '../lib/ai/gateway/novaProvider';
import { BudgetedGatewayProvider } from '../lib/ai/gateway/budgetedProvider';
import { PaidAIBudgetError } from '../lib/ai/gateway/commonBudget';
import { routeGenerateText } from '../lib/ai/gateway/router';

async function main() {
let assertions=0, paid=0, counts=0, reserves=0, settles=0, deny=false, countFails=false, timeout=false, badQuality=false;
let counted: any, generated: any;
const original=BedrockRuntimeClient.prototype.send;
(BedrockRuntimeClient.prototype as any).send=async function(command: any) {
  assert.equal(await this.config.maxAttempts(),1); assertions++;
  if(command instanceof CountTokensCommand) { counts++; counted=command.input; if(countFails) throw new Error('unsupported'); return {inputTokens:123}; }
  assert.ok(command instanceof ConverseCommand); assertions++; generated=command.input; paid++;
  if(timeout) throw new Error('timeout');
  return {output:{message:{content:generated.toolConfig ? [{toolUse:{input:{answer:'ok'}}}] : [{text:badQuality?'x':'A sufficient response for a customer.'}]}},usage:{inputTokens:123,outputTokens:10}};
};
const budget={reservePaidAttempt:async(input:any)=>{reserves++; assert.equal(input.inputTokens,300000);assert.equal(input.maxOutputTokens,4096); assertions+=2;return deny?{allowed:false as const,reason:'budget_exhausted'}:{allowed:true as const,reservation:{pricing:{modelId:"us.amazon.nova-pro-v1:0"}} as any};},settlePaidAttempt:async()=>{settles++;return true;}};
const p=new BudgetedGatewayProvider(new NovaGatewayProvider(),budget);
const policy={tier:'STANDARD' as const,promptVersion:'test',maxTokens:100000};
try {
 await p.generateText('CUSTOMER_REPLY_DRAFT','system','user',policy);
 assert.equal(counts,0);assert.equal(generated.inferenceConfig.maxTokens,4096);assert.equal(paid,1);assert.equal(settles,1);assertions+=4;
 await p.generateStructured('PRODUCT_INFORMATION_EXTRACTION','sys','usr',{name:'answer',description:'schema',input_schema:{type:'object',properties:{answer:{type:'string'}}}},policy);
 assert.equal(generated.toolConfig.tools[0].toolSpec.name,"answer"); assertions++;
 deny=true;await assert.rejects(()=>p.generateText('CUSTOMER_REPLY_DRAFT','s','u',policy),PaidAIBudgetError);assert.equal(paid,2);assertions+=2;
 deny=false;countFails=true;const before=reserves;await assert.rejects(()=>p.generateText('CUSTOMER_REPLY_DRAFT','s','u',{...policy,tier:'ECONOMY'}),PaidAIBudgetError);assert.equal(reserves,before);assert.equal(paid,2);assertions+=3;
 countFails=false;timeout=true;const settledBefore=settles;await assert.rejects(()=>p.generateText('CUSTOMER_REPLY_DRAFT','s','u',policy));assert.equal(settles,settledBefore);assertions+=2;timeout=false;
 badQuality=true;const beforePaid=paid;budget.settlePaidAttempt=async()=>{settles++;deny=true;return true;};
 await assert.rejects(()=>routeGenerateText(p,{task:'CUSTOMER_REPLY_DRAFT',systemPrompt:'s',userPrompt:'u',policy:{initialTier:'STANDARD',promptVersion:'t'},qualityRules:{minLength:20}}),PaidAIBudgetError);
 assert.equal(paid,beforePaid+1);assertions+=2;
 const unsupported=new BudgetedGatewayProvider({providerId:'unknown',generateText:async()=>{throw Error('must not call');}} as any,budget);
 await assert.rejects(()=>unsupported.generateText('CLASSIFICATION','s','u',policy),PaidAIBudgetError);assertions++;
 deny=false;badQuality=false;
 const mismatched=new NovaGatewayProvider();
 const realGenerate=mismatched.generateText.bind(mismatched);
 mismatched.generateText=async(...args)=>({...await realGenerate(...args),modelId:'unexpected-model'});
 const oldSettles=settles;
 await assert.rejects(()=>new BudgetedGatewayProvider(mismatched,budget).generateText('CUSTOMER_REPLY_DRAFT','s','u',policy),PaidAIBudgetError);
 assert.equal(settles,oldSettles);assertions+=2;
 console.log(`Budgeted provider: ${assertions} assertions passed; paid calls are SDK mocks only; counts=${counts}`);
} finally { BedrockRuntimeClient.prototype.send=original; }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
