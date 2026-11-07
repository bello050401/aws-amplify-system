import fs from 'node:fs';
import {listMercariMailIdsByQuery,fetchMercariNotificationMailsByIds} from '../../lib/messaging/email/gmailClient';
import {parseMercariNotificationMail} from '../../lib/messaging/mercari/notificationMailParser';
async function main(){
 const ids=await listMercariMailIdsByQuery('from:no-reply@mercari-shops.com newer_than:90d',20);
 const mails=await fetchMercariNotificationMailsByIds(ids);
 const counts:Record<string,number>={};
 for(const mail of mails){const parsed=parseMercariNotificationMail(mail);const key=parsed.kind+':'+parsed.status;counts[key]=(counts[key]??0)+1;}
 const result={at:new Date().toISOString(),mode:'read-only real Gmail; no persistence of bodies or addresses',found:ids.length,trusted:mails.length,counts};
 fs.writeFileSync('artifacts/whole-instruction-20261107/gmail-read.json',JSON.stringify(result,null,2));console.log(result);
 if(!ids.length||mails.length!==ids.length)process.exitCode=1;
}
main().catch(e=>{console.error(e.name);process.exitCode=1;});
