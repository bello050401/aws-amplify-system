import { NextRequest, NextResponse } from "next/server";
import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import outputs from "@/amplify_outputs.json";
import { approvedServerSession } from "@/lib/security/serverSession";
import { deviceSecurityEnabled } from "@/lib/security/serverRuntime";
import { requireBusinessPermission } from "@/lib/security/accessPolicy";
import { SecurityError } from "@/lib/security/types";
import { SECURITY_HEADERS } from "@/lib/security/http";
export const dynamic = "force-dynamic";
const s3 = new S3Client({region:outputs.storage.aws_region});
async function handle(request:NextRequest) {
  try {
    if(!deviceSecurityEnabled())throw new SecurityError("NOT_ENABLED",404);
    const actor=await approvedServerSession();if(!actor)throw new SecurityError("SIGN_IN_REQUIRED",401);
    requireBusinessPermission(actor.groups,"inventory",request.method==="GET"?"read":"write");
    const key=request.nextUrl.searchParams.get("path")??"";
    if(!key.startsWith("inventory/")||key.length>1024||/[\u0000-\u001f\\]/.test(key)||key.split("/").some(x=>x===".."||x==="."))throw new SecurityError("INVALID_PATH",400);
    const Bucket=outputs.storage.bucket_name,Key=key;
    if(request.method==="GET") {
      const data=await s3.send(new GetObjectCommand({Bucket,Key}));
      if(!data.Body)throw new SecurityError("NOT_FOUND",404);
      if(!/^image\/(jpeg|png|webp|gif|avif|heic|heif)$/.test(data.ContentType??""))throw new SecurityError("UNSUPPORTED_IMAGE",415);
      return new Response(data.Body.transformToWebStream() as ReadableStream, {headers:{...SECURITY_HEADERS,"content-type":data.ContentType!,"content-disposition":"inline"}});
    }
    if(request.method==="PUT") {
      if(!/^inventory\/(?:photo-profile\/)?[0-9a-f-]{36}\.(?:jpe?g|png|webp|gif|avif|heic|heif)$/i.test(key))throw new SecurityError("INVALID_UPLOAD_PATH",400);
      const bytes=Buffer.from(await request.arrayBuffer());if(!bytes.length||bytes.length>25*1024*1024)throw new SecurityError("INVALID_IMAGE_SIZE",413);
      const info=await sharp(bytes,{limitInputPixels:80000000}).metadata();
      const mime:Record<string,string>={jpeg:"image/jpeg",png:"image/png",webp:"image/webp",gif:"image/gif",avif:"image/avif",heif:"image/heif"};
      if(!info.format||!mime[info.format])throw new SecurityError("UNSUPPORTED_IMAGE",415);
      await s3.send(new PutObjectCommand({Bucket,Key,Body:bytes,ContentType:mime[info.format],CacheControl:"private, no-store",IfNoneMatch:"*",Metadata:{"bello-uploader":actor.sub}}));
      return NextResponse.json({ok:true},{headers:SECURITY_HEADERS});
    }
    // This operation only discards this user's newly uploaded images. Product
    // deletion continues through the existing reference-aware inventory service.
    const data=await s3.send(new HeadObjectCommand({Bucket,Key}));
    if(data.Metadata?.["bello-uploader"]!==actor.sub)throw new SecurityError("IMAGE_OWNER_REQUIRED");
    // A browser's upload ownership is not proof that no saved product now uses
    // this key (another tab may have committed it). Leave physical deletion to
    // the existing reference-aware abandoned-upload collector. Saved-product
    // image deletion still runs immediately through its inventory transaction.
    return NextResponse.json({ok:true,cleanup:"reference-aware-collector"},{headers:SECURITY_HEADERS});
  }catch(error){const e=error instanceof SecurityError?error:new SecurityError("STORAGE_UNAVAILABLE",503);return NextResponse.json({error:e.code},{status:e.status,headers:SECURITY_HEADERS});}
}
export const GET=handle;export const PUT=handle;export const DELETE=handle;
