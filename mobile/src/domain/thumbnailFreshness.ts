/** Persisting a signed URL must not turn yesterday's expired photo into a permanent blank. */
export function reusableThumbnail(url:string|null,now=Date.now()):boolean {
 if(!url)return false;
 try{
  const u=new URL(url),signed=u.searchParams.get('X-Amz-Date'),expires=Number(u.searchParams.get('X-Amz-Expires'));
  if(signed){
   if(!/^\d{8}T\d{6}Z$/.test(signed)||!Number.isFinite(expires))return false;
   const date=Date.parse(`${signed.slice(0,4)}-${signed.slice(4,6)}-${signed.slice(6,8)}T${signed.slice(9,11)}:${signed.slice(11,13)}:${signed.slice(13,15)}Z`);
   return date+expires*1000>now+60000;
  }
  return u.protocol==='https:';
 }catch{return false;}
}
