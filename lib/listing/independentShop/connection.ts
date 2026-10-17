import "server-only";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { createIndependentShopClient } from "./client";
import { ListingError } from "./workflow";
const SECRET_NAME="bello/independent-shop-connection";
export async function independentShopConnection() {
 // Connection is opt-in. Unconfigured deployments support preview without any AWS/API call.
 if(process.env.BELLO_SHOP_CONNECTION_ENABLED!=="1")return null;
 // Local development can supply server-only env. Hosted credentials use one dedicated Secret.
 let apiKey=process.env.BELLO_SHOP_API_KEY||"",sitesServiceToken=process.env.BELLO_SHOP_SERVICE_TOKEN||"";
 if(!apiKey||!sitesServiceToken){
  try{
   const client=new SecretsManagerClient({region:process.env.AWS_REGION||"us-west-2"});
   const value=await client.send(new GetSecretValueCommand({SecretId:SECRET_NAME}));
   const data=JSON.parse(value.SecretString||"{}");
   if(data.enabled!==true)return null;
   apiKey=data.apiKey;sitesServiceToken=data.sitesServiceToken;
  }catch(error){
   if(error instanceof Error&&error.name==="ResourceNotFoundException")return null;
   throw new ListingError("自社サイトの接続設定を読み取れません。管理者に設定の確認を依頼してください。");
  }
 }
 if(typeof apiKey!=="string"||!/^bello_[a-f0-9]{64}$/.test(apiKey)||typeof sitesServiceToken!=="string"||!sitesServiceToken.trim())return null;
 return {api:createIndependentShopClient({apiKey,sitesServiceToken}),signingKey:apiKey};
}
