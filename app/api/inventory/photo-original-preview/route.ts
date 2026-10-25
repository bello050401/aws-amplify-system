import {NextResponse} from 'next/server';
import sharp from 'sharp';
import {temporaryOriginalWeb} from '@/lib/photoRegistration/temporaryOriginalWeb';
export const dynamic='force-dynamic';
// On-demand preview stays in memory; no derivative is stored in S3.
export async function GET(request:Request){
 const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
 const service=await temporaryOriginalWeb();if(!service)return new NextResponse(null,{status:403,headers});
 try{
  const source=await service.previewBytes(new URL(request.url).searchParams.get('id')??'');
  if(!source)return new NextResponse(null,{status:404,headers});let bytes:Buffer=source.bytes;
  if(/\.(arw|cr2|cr3|nef|dng|orf|rw2)$/i.test(source.fileName)){
   let best:Buffer|null=null,area=0;
   for(let i=0;i<bytes.length-3;i++){
    if(bytes[i]!==255||bytes[i+1]!==216||bytes[i+2]!==255)continue;
    const end=bytes.indexOf(Buffer.from([255,217]),i+3);if(end<0)break;if(end-i<16384)continue;
    const candidate=bytes.subarray(i,end+2);
    try{const m=await sharp(candidate,{limitInputPixels:80000000}).metadata();if((m.width??0)*(m.height??0)>area){best=candidate;area=(m.width??0)*(m.height??0);}}catch{}
   }
   if(!best)return new NextResponse(null,{status:415,headers});bytes=best;
  }
  const preview=await sharp(bytes,{limitInputPixels:80000000}).rotate().resize(1200,1200,{fit:'inside',withoutEnlargement:true}).jpeg({quality:82}).toBuffer();
  return new NextResponse(new Uint8Array(preview),{headers:{...headers,'Content-Type':'image/jpeg'}});
 }catch{return new NextResponse(null,{status:422,headers});}
}
