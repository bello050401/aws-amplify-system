import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { uploadData } from "aws-amplify/storage/server";
import { runWithAmplifyServerContext } from "@/lib/amplify/serverUtils";
import { getMobileSession } from "@/lib/mobile/session";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const headers = { "Cache-Control":"private, no-store", Vary:"Cookie" };
  const fail = (status:number) => NextResponse.json({error:"IMAGE_UNAVAILABLE"},{status,headers});
  const session = await getMobileSession();
  if (!session.ok) return fail(session.status);
  if (session.role === "VIEWER" || process.env.BELLO_MOBILE_WRITES_ENABLED !== "true") return fail(403);
  const origin = request.headers.get("origin");
  if (request.headers.get("x-bello-mobile") !== "1" || request.headers.get("sec-fetch-site") === "cross-site" ||
    (origin && origin !== (process.env.BELLO_MOBILE_PUBLIC_ORIGIN || new URL(request.url).origin))) return fail(403);
  const id = request.headers.get("x-photo-id") ?? "";
  if (!/^[a-f0-9-]{36}$/i.test(id) || request.headers.get("content-type") !== "image/jpeg") return fail(422);
  const reader = request.body?.getReader();
  if (!reader) return fail(400);
  try {
    let size=0; const chunks:Uint8Array[]=[];
    try { while (true) { const {value,done}=await reader.read(); if(done)break; size+=value.byteLength;
      if(size>3*1024*1024){await reader.cancel();return fail(413);} chunks.push(value); } }
    finally {reader.releaseLock();}
    // Decode actual image bytes, strip EXIF and normalize orientation. No filename or MIME trust.
    const bytes=await sharp(Buffer.concat(chunks),{limitInputPixels:40000000}).rotate().resize({width:2000,height:2000,fit:"inside",withoutEnlargement:true}).jpeg({quality:88}).toBuffer();
    const hash=createHash("sha256").update(bytes).digest("hex");
    const storageKey=`inventory/mobile/${session.owner}/${id}/${hash}.jpg`;
    await runWithAmplifyServerContext({nextServerContext:{cookies},operation:context=>uploadData(context,{path:storageKey,data:bytes,options:{contentType:"image/jpeg"}}).result});
    return NextResponse.json({owner:session.owner,storageKey},{headers});
  } catch {return fail(503);}
}
