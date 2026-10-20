import 'server-only';
import outputs from '@/amplify_outputs.json';
import {SESv2Client,SendEmailCommand,GetEmailIdentityCommand} from '@aws-sdk/client-sesv2';
import {createHash} from 'node:crypto';
import type {OutboundBatch} from './types';
import {kawagoeAttachments} from './kawagoe';

const client=new SESv2Client({region:process.env.AWS_REGION||'us-west-2',maxAttempts:1});
const address=/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const base64=(data:Buffer)=>data.toString('base64').match(/.{1,76}/g)!.join('\r\n');
const word=(text:string)=>`=?UTF-8?B?${Buffer.from(text).toString('base64')}?=`;
export function buildOutboundEmail(batch:OutboundBatch):Buffer {
 if(!address.test(batch.emailTo??'')||!address.test(batch.emailFrom??''))throw Error('出庫メールの送信元と送信先を設定してください。');
 const files=kawagoeAttachments(batch),boundary='bello-'+createHash('sha256').update(batch.id).digest('hex');
 const total=batch.rows.filter(r=>r.status==='PENDING'||r.status==='SENT').reduce((s,r)=>s+r.snapshot.quantity,0);
 const testPrefix=(outputs as {custom?:{isolatedQa?:{enabled?:boolean}}}).custom?.isolatedQa?.enabled?'【動作確認テスト・入荷予定ではありません】\n':'';
 const body=`${testPrefix}川越への入荷予定データです。\n\n発注番号：${batch.orderNumber}\n入荷予定日：${batch.arrivalDate}\n数量：${total}点\n\n商品マスタ取込CSVと入荷予定CSVの2ファイルを添付しています。\n出庫番号：${batch.id}\n`;
 const parts=[`From: ${batch.emailFrom}`,`To: ${batch.emailTo}`,`Subject: ${word(`${testPrefix?"【テスト】 ":""}BELLO 川越 入荷予定 ${batch.orderNumber}`)}`,'MIME-Version: 1.0',`Content-Type: multipart/mixed; boundary="${boundary}"`,'',`--${boundary}`,'Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',base64(Buffer.from(body))];
 for(const file of files)parts.push(`--${boundary}`,'Content-Type: text/csv; charset=Shift_JIS',`Content-Disposition: attachment; filename="${word(file.fileName)}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,'Content-Transfer-Encoding: base64','',base64(file.data));
 parts.push(`--${boundary}--`,'');return Buffer.from(parts.join('\r\n'));
}
export async function assertOutboundEmailReady(batch:OutboundBatch){
 buildOutboundEmail(batch);
 const result=await client.send(new GetEmailIdentityCommand({EmailIdentity:batch.emailFrom}));
 if(!result.VerifiedForSendingStatus)throw Error('送信元メールアドレスの認証が完了していません。確認メール内のリンクを開いてください。');
}
export async function sendOutboundEmail(batch:OutboundBatch):Promise<string>{
 const result=await client.send(new SendEmailCommand({FromEmailAddress:batch.emailFrom,Destination:{ToAddresses:[batch.emailTo!]},Content:{Raw:{Data:buildOutboundEmail(batch)}}}));
 if(!result.MessageId)throw Error('メール送信結果を確認できません。');return result.MessageId;
}
export function isDefiniteEmailFailure(error:unknown):boolean {
 // A timeout/5xx may have delivered the email. Never automatically send it twice.
 return ['MessageRejected','BadRequestException','MailFromDomainNotVerifiedException','NotFoundException','SendingPausedException','AccountSuspendedException','AccessDeniedException','TooManyRequestsException'].includes((error as {name?:string})?.name??'');
}
