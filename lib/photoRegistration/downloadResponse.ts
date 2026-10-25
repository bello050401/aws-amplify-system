import {NextResponse} from "next/server";

/** The URL must come from an authenticated photo service, never from request input. */
export function photoDownloadResponse(request:Request,url:string){
 const headers={"Cache-Control":"private, no-store","Vary":"Accept","X-Content-Type-Options":"nosniff"};
 if(!request.headers.get("accept")?.includes("application/json"))return NextResponse.redirect(url,{status:302,headers});
 const disposition=new URL(url).searchParams.get("response-content-disposition")??"";
 let fileName="BELLO-photo.jpg";
 const encoded=disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
 const plain=disposition.match(/filename="?([^";]+)"?/i)?.[1];
 try{fileName=encoded?decodeURIComponent(encoded):plain||fileName;}catch{}
 fileName=fileName.replace(/[\r\n\\/]/g,"_");
 return NextResponse.json({url,fileName},{headers});
}
