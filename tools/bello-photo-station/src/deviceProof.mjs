import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('base64url');
export function windowsDeviceProof({url,method,body,token},spawnImpl=spawn){
  const endpoint=new URL(url);if(endpoint.protocol!=='https:')throw Error('HTTPS is required');
  let sub;try{sub=JSON.parse(Buffer.from(token.split('.')[1],'base64url')).sub;}catch{throw Error('ログインを確認してください。');}
  if(typeof sub!=='string'||!sub)throw Error('ログインを確認してください。');
  // The server verifies this JWT independently. Decoding here only binds the
  // local proof; it never grants a role or authenticates a user.
  const proof={version:1,at:Math.floor(Date.now()/1000),nonce:randomBytes(32).toString('base64url'),binding:hash('photo#'+sub),digest:hash(body)};
  const message=['BELLO-HTTP-PROOF-v1',endpoint.origin,method,endpoint.pathname+endpoint.search,String(proof.at),proof.nonce,proof.binding,proof.digest].join('\n');
  return new Promise((resolve,reject)=>{
    const executable=process.env.BELLO_DEVICE_SIGNER_EXE;
    if(!executable){reject(Error('端末認証に対応したPhotoStationから実行してください。'));return;}
    const child=spawnImpl(executable,['--sign-device-request'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output='';const timer=setTimeout(()=>{child.kill();reject(Error('端末署名がタイムアウトしました。'));},15000);
    child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length>8192){child.kill();}});
    child.on('error',()=>{clearTimeout(timer);reject(Error('Windowsの端末認証を起動できません。'));});
    child.on('close',code=>{clearTimeout(timer);try{if(code!==0)throw Error();const value=JSON.parse(output);resolve({'x-bello-device-key':JSON.stringify(value.key),'x-bello-device-proof':JSON.stringify({...proof,signature:value.signature})});}catch{reject(Error('Windowsの端末認証に失敗しました。'));}});
    child.stdin.end(JSON.stringify({message}));
  });
}
