import * as legacy from "aws-amplify/storage/server";
import { S3Client, GetObjectCommand, PutObjectCommand, CopyObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import outputs from "@/amplify_outputs.json";
import { deviceSecurityEnabled } from "./serverRuntime";
import { approvedServerSession } from "./serverSession";
import { requireBusinessPermission } from "./accessPolicy";
import { SecurityError } from "./types";
import { deleteAllPhotoObjectVersions } from "../mediaMaintenance/deletePhotoObject";
const s3=new S3Client({region:outputs.storage.aws_region}),Bucket=outputs.storage.bucket_name;
async function allow(path:unknown,write=false) {
  const actor=await approvedServerSession();if(!actor)throw new SecurityError("SIGN_IN_REQUIRED",401);
  if(typeof path!=="string"||path.length>1024||/[\u0000-\u001f\\]/.test(path)||path.split("/").some(x=>x===".."||x==="."))throw new SecurityError("INVALID_STORAGE_PATH",400);
  if(path.startsWith("inventory/"))requireBusinessPermission(actor.groups,"inventory",write?"write":"read");
  else if(path.startsWith("knowledge/"))requireBusinessPermission(actor.groups,"inventory","admin");
  else throw new SecurityError("STORAGE_PATH_DENIED");
  return path;
}
type ServerContext = Parameters<typeof legacy.getUrl>[0];
type PathInput = { path: string; options?: { contentType?: string } };
export const getUrl:typeof legacy.getUrl=(async(context:ServerContext,input:PathInput)=>{
  if(!deviceSecurityEnabled())return legacy.getUrl(context,input);
  const Key=await allow(input.path);
  // Server image-processing consumers need an HTTPS URL. Never issue the legacy
  // hour/day-long URLs; a leaked already-issued URL has at most 30 seconds left.
  const url=await getSignedUrl(s3,new GetObjectCommand({Bucket,Key,ResponseCacheControl:"private, no-store"}),{expiresIn:30});
  return {url:new URL(url),expiresAt:new Date(Date.now()+30000)};
}) as typeof legacy.getUrl;
export const uploadData:typeof legacy.uploadData=((context:ServerContext,input:PathInput & {data:Buffer|Uint8Array|string})=>{
  if(!deviceSecurityEnabled())return legacy.uploadData(context,input);
  const result=(async()=>{const Key=await allow(input.path,true);await s3.send(new PutObjectCommand({Bucket,Key,Body:input.data,ContentType:input.options?.contentType,CacheControl:"private, no-store"}));return{path:Key};})();
  return{result};
}) as typeof legacy.uploadData;
export const copy:typeof legacy.copy=(async(context:ServerContext,input:{source:PathInput;destination:PathInput})=>{
  if(!deviceSecurityEnabled())return legacy.copy(context,input);
  const [source,Key]=await Promise.all([allow(input.source.path),allow(input.destination.path,true)]);
  await s3.send(new CopyObjectCommand({Bucket,Key,CopySource:encodeURIComponent(Bucket+"/"+source)}));return{path:Key};
}) as typeof legacy.copy;
export async function remove(context:Parameters<typeof legacy.getUrl>[0],input:{path:string}) {
  if(!deviceSecurityEnabled()){
    const operation=legacy.remove(context,input);
    return 'result' in operation?operation.result:operation;
  }
  const Key=await allow(input.path,true);await deleteAllPhotoObjectVersions(s3,Bucket,Key);return{path:Key};
}
