import 'server-only';
import {LambdaClient,InvokeCommand} from '@aws-sdk/client-lambda';
import outputs from '../../../amplify_outputs.json';
export async function wakeNative(){
 const fn=(outputs.custom as {saleAutomation?:{functionName?:string}})?.saleAutomation?.functionName;
 if(fn)try{await new LambdaClient({region:process.env.AWS_REGION||'us-west-2',maxAttempts:1}).send(new InvokeCommand({FunctionName:fn,InvocationType:'Event',Payload:Buffer.from('{"mode":"EC_NATIVE"}')}),{abortSignal:AbortSignal.timeout(1200)});}catch{/* Minute scheduler recovers lost wake-up. */}
}
