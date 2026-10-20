/** Read one page only, never mutate. Do not print the secret or product data. */
import {SecretsManagerClient,GetSecretValueCommand} from '@aws-sdk/client-secrets-manager';
import {createV2Client} from '../../lib/zaico/transition/v2Client';
async function main(){
 const response=await new SecretsManagerClient({region:'us-west-2'}).send(new GetSecretValueCommand({SecretId:'bello/zaico-api-token'}));
 const secret=JSON.parse(response.SecretString!);
 let requests=0;
 const api=createV2Client({companyId:184402,token:async()=>secret.token,beforeRequest:async(method)=>{if(method!=='GET')throw Error('Read only');requests++;}});
 const result=await api.list({end:new Date().toISOString(),page:1,includeDeleted:true});
 const sample=result.data.find(row=>row.deleted===false)!;
 const detail=await api.get(String(sample.id));
 console.log(JSON.stringify({pagination:result.pagination,firstPageCount:result.data.length,detailVerified:detail?.id===sample.id,requests}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
