export type LoginSessionStatus='authorized'|'signed-in-not-authorized'|'signed-out';

/** A failed identity check must neither authorize data access nor hide the login form forever. */
export async function checkLoginSession(read:()=>Promise<LoginSessionStatus>,timeoutMs=8000):Promise<{status:LoginSessionStatus;failed:boolean}> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const status=await Promise.race([read(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('SESSION_CHECK_TIMEOUT')),timeoutMs);})]);
    return {status,failed:false};
  } catch {
    return {status:'signed-out',failed:true};
  } finally {if(timer)clearTimeout(timer);}
}
