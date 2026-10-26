import { randomUUID, createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {GetSecretValueCommand,SecretsManagerClient} from '@aws-sdk/client-secrets-manager';
import { createStockSplitService } from "../../lib/inventory/stockSplitCore";
import { createInventoryPersistence } from "../../lib/inventory/categoryPersistenceCore";
import { SecurityService } from "../../lib/security/service";
import { SecurityError } from "../../lib/security/types";
import { COOKIE, SECURITY_HEADERS, type HttpRequest } from "../../lib/security/http";

const db=DynamoDBDocumentClient.from(new DynamoDBClient({}),{marshallOptions:{removeUndefinedValues:true}});
function table(model:string){
  if(!["Inventory","InventoryHistory","InventoryCategory","Category"].includes(model))throw new SecurityError("MODEL_DENIED");
  const value=process.env["PILOT_"+model.toUpperCase()+"_TABLE"];if(!value)throw new SecurityError("STAGE_NOT_CONFIGURED",503);return value;
}
const persistence=createInventoryPersistence(db,table);
let dataGate:Promise<string>|undefined;
function gate(){return dataGate??=(async()=>{const s=await new SecretsManagerClient({}).send(new GetSecretValueCommand({SecretId:process.env.SECURITY_APPSYNC_GATE_SECRET_ARN}));const value=JSON.parse(s.SecretString??'{}').value;if(typeof value!=='string'||value.length<43)throw new Error('DATA_GATE_NOT_CONFIGURED');return value;})().catch(error=>{dataGate=undefined;throw error;});}
const split=createStockSplitService({db,table,nextSku:async()=>"QA-"+randomUUID(),
  copyPhotos:async(source)=>{if(Array.isArray(source.images)&&source.images.length)throw new SecurityError("STAGE_PHOTO_COPY_NOT_ENABLED",409);return[];},discardPhotos:async()=>{}});

/** Isolated fixture tables; the same transaction core used by the real inventory API. */
export async function businessHttp(service:SecurityService,req:HttpRequest){
  try{
    if(!req.path.startsWith("/api/business/inventory"))throw new SecurityError("NOT_FOUND",404);
    if(Buffer.byteLength(req.body)>49152)throw new SecurityError("REQUEST_TOO_LARGE",413);
    const token=(req.headers.cookie??"").split(";").map(x=>x.trim()).find(x=>x.startsWith(COOKIE+"="))?.slice(COOKIE.length+1)??"";
    const proof=JSON.parse(req.headers["x-bello-device-proof"]??"null");
    const actor=await service.authorizeRequest(token,{method:req.method,target:req.path,digest:createHash("sha256").update(req.body).digest("base64url"),proof},
      {origin:req.headers.origin??"",ip:req.ip,userAgent:req.headers["user-agent"]??""});
    service.requireBusinessPermission(actor.groups,"inventory",req.method==="GET"?"read":"write");
    let value:unknown;
    if(req.method==="POST"&&req.path==="/api/business/inventory/split")value=await split(JSON.parse(req.body),actor.sub);
    else if(req.method==="POST"&&req.path==="/api/business/inventory"){
      const input=JSON.parse(req.body);
      // Stage routes accept fixture fields only, never table names/roles/owner.
      if(typeof input.name!=="string"||!input.name.startsWith("SECURITY QA ")||!Number.isSafeInteger(input.quantity)||input.quantity<1)throw new SecurityError("INVALID_FIXTURE",400);
      value=await persistence.persistInventoryWithCategories({name:input.name,quantity:input.quantity,categoryIds:[],images:[],createdBy:actor.sub,updatedBy:actor.sub});
    }else if(req.method==="GET"&&/^\/api\/business\/inventory\/[0-9a-f-]{36}$/.test(req.path)){
      const response=await fetch(process.env.PILOT_GRAPHQL_URL!,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json',Authorization:actor.tokens.id,'x-bello-data-gate':await gate()},body:JSON.stringify({query:'query Inventory($id:ID!){getInventory(id:$id){id name quantity}}',variables:{id:req.path.split('/').at(-1)}})});
      const result=await response.json() as {data?:{getInventory?:unknown};errors?:unknown};
      if(!response.ok||result.errors)throw new SecurityError('DATA_BOUNDARY_UNAVAILABLE',503);
      value=result.data?.getInventory;
      if(!value)throw new SecurityError("NOT_FOUND",404);
    }else throw new SecurityError("NOT_FOUND",404);
    return{statusCode:200,headers:SECURITY_HEADERS,body:JSON.stringify({ok:true,value})};
  }catch(error){const e=error instanceof SecurityError?error:new SecurityError("BUSINESS_REQUEST_FAILED",409);return{statusCode:e.status,headers:SECURITY_HEADERS,body:JSON.stringify({error:e.code})};}
}
