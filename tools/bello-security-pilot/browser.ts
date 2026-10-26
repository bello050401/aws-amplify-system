import {clearLegacyBrowserCredentials} from '../../lib/security/browserMigration';
import {isTerminalSessionError} from '../../lib/security/sessionInvalidation';
clearLegacyBrowserCredentials();
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => element<HTMLInputElement>(id);
const encoder = new TextEncoder();
const b64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), x => x.charCodeAt(0));
const messages: Record<string,string> = {
  LOGIN_FAILED: "ログインできませんでした。入力内容と登録状況を確認してください。",
  PASSKEY_REQUIRED: "登録済みのパスキーで本人確認してください。",
  PASSKEY_NOT_AVAILABLE: "このアカウントではパスキーを利用できません。初回登録を確認してください。",
  DEVICE_PENDING: "管理者の端末承認をお待ちください。",
  DEVICE_REJECTED: "この端末からのアクセスは許可されていません。",
  DEVICE_REVOKED: "この端末の承認が解除されています。管理者に確認してください。",
  SESSION_EXPIRED: "ログインの有効期限が切れました。パスキーで再開できます。",
  SIGN_IN_REQUIRED: "ログインしてください。",
  INVALID_DEVICE_PROOF: "このブラウザの端末登録を確認できません。ログインし直してください。",
  PERSON_VERIFICATION_REQUIRED: "スタッフ本人に申請番号を確認し、本人確認欄にチェックしてください。",
  STALE_RECORD: "状態が変更されています。再読み込みして確認してください。",
  REAUTHENTICATE: "管理操作のため、パスキーでもう一度本人確認してください。",
  ACCOUNT_DISABLED: "このアカウントの利用は停止されています。",
  TOO_MANY_REQUESTS: "操作が集中しています。少し待ってからお試しください。",
  STAFF_ALREADY_EXISTS:'このスタッフはすでに登録されています。',
  STAFF_CREATION_UNCONFIRMED:'作成結果を確認できません。重複操作をせず、管理者が登録状況を確認してください。',
  INVALID_STAFF_INPUT:'メールアドレス・権限・本人確認欄を確認してください。',
};
let keyPair: CryptoKeyPair, username = "", current: Record<string,unknown> = {};
let busy = false, deviceCursor: string|undefined, userCursor: string|undefined, eventCursor: string|undefined;
let events: Record<string,unknown>[] = [];
async function db() {
  return new Promise<IDBDatabase>((resolve,reject) => {
    const r=indexedDB.open("bello-approved-browser-v1",1);
    r.onupgradeneeded=()=>r.result.createObjectStore("settings");
    r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error);
  });
}
async function saved<T>(key:string,value?:T):Promise<T|undefined>{
  const d=await db();
  try{return await new Promise<T|undefined>((resolve,reject)=>{
    const tx=d.transaction("settings",value===undefined?"readonly":"readwrite"), s=tx.objectStore("settings");
    const r=value===undefined?s.get(key):s.put(value,key);
    tx.oncomplete=()=>resolve(value===undefined?r.result:value);tx.onerror=()=>reject(tx.error);
  });}finally{d.close();}
}
function showError(e:unknown){
  const code=(e as Error).message;
  // Do not leave a stale approved/pending screen or administrator records
  // visible after the server has invalidated this session. Keep the browser
  // key: an ordinary session expiry must not force another device approval.
  if(['ACCOUNT_DISABLED','DEVICE_REVOKED','SESSION_EXPIRED','SIGN_IN_REQUIRED'].includes(code)){
    current={};events=[];deviceCursor=userCursor=eventCursor=undefined;
    element('session').hidden=true;element('admin').hidden=true;element('login').hidden=false;
    for(const id of ['devices','users','events'])element(id).replaceChildren();
    for(const id of ['account','verify-code','probe-result'])element(id).textContent='';
    for(const id of ['password','staff-temporary-password'])input(id).value='';
    element('staff-created').hidden=true;
    void saved('requestBinding','').catch(()=>{});
  }
  if(code==='DEVICE_REVOKED')element('re-register').hidden=false;
  if(code==='REAUTHENTICATE'){element('passkey-again').hidden=false;element('passkey-again').textContent='管理操作のためパスキーで本人確認';}
  element("error").textContent=messages[code]??((e as Error).name==="NotAllowedError"?"本人確認をキャンセルしました。":"処理を完了できませんでした。時間をおいて再度お試しください。");element("error").hidden=false;
  if(["REAUTHENTICATE","SESSION_EXPIRED","SIGN_IN_REQUIRED"].includes(code)){
    element("passkey-again").hidden=false;
    element("passkey-again").textContent="パスキーで本人確認して再開";
  }
}
async function run(fn:()=>Promise<void>){
  if(busy)return;busy=true;element("error").hidden=true;
  document.querySelectorAll("button").forEach(b=>(b as HTMLButtonElement).disabled=true);
  try{await fn();}catch(e){showError(e);}finally{busy=false;document.querySelectorAll("button").forEach(b=>(b as HTMLButtonElement).disabled=false);}
}
async function post(path:string,body:unknown){
  const r=await fetch(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),credentials:"same-origin",cache:"no-store",redirect:"error"});
  const data=await r.json();if(!r.ok)throw new Error(data.error??"UNAVAILABLE");return data;
}
async function action(payload:unknown){
  const raw=JSON.stringify(payload),digest=b64(await crypto.subtle.digest("SHA-256",encoder.encode(raw)));
  const c=await post("/api/security/challenge",{digest});
  const signature=b64(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},keyPair.privateKey,encoder.encode(c.message)));
  return post("/api/security/action",{payload:raw,proof:{challengeId:c.challengeId,signature}});
}
function options(raw:any,creating=false){
  if(typeof raw==="string")raw=JSON.parse(raw);
  const p={...raw,challenge:unb64(raw.challenge),userVerification:"required"};
  if(creating){p.user={...raw.user,id:unb64(raw.user.id)};p.authenticatorSelection={...raw.authenticatorSelection,userVerification:"required",residentKey:"required"};p.excludeCredentials=(raw.excludeCredentials??[]).map((c:any)=>({...c,id:unb64(c.id)}));}
  else p.allowCredentials=(raw.allowCredentials??[]).map((c:any)=>({...c,id:unb64(c.id)}));
  return p;
}
/** First-time password changes are masked; never use a visible browser prompt. */
async function challengeAnswer(step:string):Promise<string>{
  const dialog=element<HTMLDialogElement>("auth-challenge"),form=element<HTMLFormElement>("challenge-form");
  const password=step==="NEW_PASSWORD_REQUIRED",field=input("challenge-answer");
  element("challenge-title").textContent=password?"初回パスワードの設定":"本人確認コード";
  element("challenge-description").textContent=password?"14文字以上で、英大文字・小文字・数字・記号を含めて設定してください。以後はパスキーでログインできます。":"認証アプリなどに表示されているコードを入力してください。";
  field.type=password?"password":"text";field.autocomplete=password?"new-password":"one-time-code";field.inputMode=password?"text":"numeric";field.minLength=password?14:1;field.value="";
  element("challenge-confirm-label").hidden=!password;input("challenge-confirm").required=password;input("challenge-confirm").value="";
  // run() disabled existing controls; only this modal may accept input while awaiting an answer.
  dialog.querySelectorAll("button").forEach(b=>b.disabled=false);
  return new Promise((resolve,reject)=>{
    const finish=(value?:string)=>{field.value="";input("challenge-confirm").value="";dialog.close();form.onsubmit=null;dialog.oncancel=null;value?resolve(value):reject(new DOMException("Cancelled","NotAllowedError"));};
    form.onsubmit=e=>{e.preventDefault();if(password&&field.value!==input("challenge-confirm").value){input("challenge-confirm").setCustomValidity("パスワードが一致しません。");input("challenge-confirm").reportValidity();return;}finish(field.value);};
    input("challenge-confirm").oninput=()=>input("challenge-confirm").setCustomValidity("");
    element("challenge-cancel").onclick=()=>finish();dialog.oncancel=e=>{e.preventDefault();finish();};dialog.showModal();field.focus();
  });
}
function credential(c:PublicKeyCredential){
  const r=c.response as AuthenticatorAttestationResponse & AuthenticatorAssertionResponse;
  return {id:c.id,rawId:b64(c.rawId),type:c.type,authenticatorAttachment:c.authenticatorAttachment,
    clientExtensionResults:c.getClientExtensionResults(),response:{
      clientDataJSON:b64(r.clientDataJSON),
      ...(r.attestationObject?{attestationObject:b64(r.attestationObject),transports:r.getTransports?.()??[]}:{}),
      ...(r.authenticatorData?{authenticatorData:b64(r.authenticatorData),signature:b64(r.signature),userHandle:r.userHandle?b64(r.userHandle):null}:{}),
    }};
}
async function login(mode:"passkey"|"password"){
  username=input("username").value.trim()||username;
  let r=await post("/api/security/login",{username,mode,password:mode==="password"?input("password").value:undefined,key:await crypto.subtle.exportKey("jwk",keyPair.publicKey),name:input("device-name").value||navigator.platform,shared:input("shared").checked});
  input("password").value="";
  while(r.flowToken){
    let answer:unknown;
    if(r.step==="WEB_AUTHN"){const c=await navigator.credentials.get({publicKey:options(r.options)}) as PublicKeyCredential|null;if(!c)throw new Error("LOGIN_FAILED");answer=credential(c);}
    else answer=await challengeAnswer(r.step);
    r=await post("/api/security/finish",{flowToken:r.flowToken,answer});
  }
  await saved("username",username);await refresh();
}
async function refresh(){
  current=await action({action:"status"});
  await saved("requestBinding",String(current.requestBinding??""));
  if (current.status === "rejected") {
    document.body.replaceChildren();
    document.body.className="access-rejected";
    add(document.body,"div","警察に通報させていただきます。\n\nざまあみやがれ\n\nお前はブタ箱行きだ。");
    return;
  }
  if(current.approved && document.body.dataset.business === "1") {
    await navigator.serviceWorker.register("/security-worker.js", {scope:"/", updateViaCache:"none"});
    await navigator.serviceWorker.ready;
    if(!navigator.serviceWorker.controller) await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error("DEVICE_PROOF_UNAVAILABLE")),10000);
      navigator.serviceWorker.addEventListener("controllerchange",()=>{clearTimeout(timer);resolve();},{once:true});
    });
  }
  element("login").hidden=true;element("session").hidden=false;
  element("status-title").textContent=({pending:"端末の承認待ち",approved:"端末は承認されています",rejected:"アクセスは許可されていません",revoked:"端末の承認が解除されています"} as Record<string,string>)[String(current.status)]??"状態確認";
  element("status-description").textContent=current.approved?"このブラウザで安全に利用を再開できます。":current.status==="pending"?"下の申請番号を管理者に伝えてください。承認が完了するまでは業務データを取得できません。":current.status==="approved"?"パスキーによる本人確認を完了してください。":"管理者に確認してください。";
  element("account").textContent=String(current.username)+" ／ "+String(current.name)+(current.shared?"（共用端末）":"");
  element("verify-code").hidden=current.status!=="pending";element("verify-code").textContent="申請番号 "+current.verificationCode;
  element("enroll").hidden=Boolean(current.passkeyRegistered)||["rejected","revoked"].includes(String(current.status));
  element("passkey-again").hidden=!current.passkeyRegistered||!current.needsPasskeyLogin;
  element("probe").hidden=!current.approved;element("admin").hidden=!(current.approved&&current.admin);
  element("re-register").hidden=!["rejected","revoked"].includes(String(current.status));
  if (current.approved && document.body.dataset.business === "1" && new URLSearchParams(location.search).has("returnTo")) {
    const target=new URLSearchParams(location.search).get("returnTo")||"/inventory";
    location.replace(target.startsWith("/")&&!target.startsWith("//")&&!target.includes("\\")&&!target.startsWith("/security")?target:"/inventory");
    return;
  }
  if(current.approved&&current.admin){await load("devices");await load("users");}
}
function add(parent:HTMLElement,tag:string,text:string,cls?:string){const e=document.createElement(tag);e.textContent=text;if(cls)e.className=cls;parent.append(e);return e;}
function button(parent:HTMLElement,text:string,fn:()=>Promise<void>,cls="secondary"){const e=add(parent,"button",text,cls);e.onclick=()=>run(fn);return e;}
const date=(v:unknown)=>new Date(Number(v)*1000).toLocaleString("ja-JP");
async function load(kind:"devices"|"users"|"events",more=false){
  const cursor=more?(kind==="devices"?deviceCursor:kind==="users"?userCursor:eventCursor):undefined;
  const r=await action({action:kind,cursor}),area=element(kind);
  if(!more){area.replaceChildren();if(kind==="events")events=[];}
  if(kind==="devices")deviceCursor=r.cursor;else if(kind==="users")userCursor=r.cursor;else eventCursor=r.cursor;
  element("more-"+kind).hidden=!r.cursor;
  for(const item of r.items){
    const box=document.createElement("div");box.className=kind==="events"?"event":"device";area.append(box);
    if(kind==="devices"){
      add(box,"h3",item.name);add(box,"span",({pending:"承認待ち",approved:"承認済み",rejected:"拒否",revoked:"承認解除"} as Record<string,string>)[item.status],"tag");
      add(box,"p","スタッフ："+(item.username??item.sub)+" ／ 最終利用："+date(item.lastSeenAt)+" ／ IP："+item.lastIp);
      add(box,"p",item.userAgent+(item.shared?" ／ 共用端末":" ／ 個人端末"));
      if(item.status==="pending"){
        const l=add(box,"label","本人から確認した申請番号"),code=document.createElement("input");code.inputMode="numeric";code.maxLength=6;l.append(code);
        const checked=add(box,"label","対面・電話などで本人に確認しました","check"),cb=document.createElement("input");cb.type="checkbox";checked.prepend(cb);
        button(box,"承認",async()=>{await action({action:"approve",deviceId:item.id,expectedVersion:item.version,verificationCode:code.value,personConfirmed:cb.checked});await load("devices");},"");
        button(box,"拒否",async()=>{if(confirm("この端末からのアクセスを拒否しますか？")){await action({action:"reject",deviceId:item.id,expectedVersion:item.version});await load("devices");}},"danger");
      }else if(item.status==="approved")button(box,"承認解除",async()=>{if(confirm("この端末のアクセスを停止しますか？")){await action({action:"revoke",deviceId:item.id,expectedVersion:item.version});await load("devices");}},"danger");
    }else if(kind==="users"){
      add(box,"h3",item.username);add(box,"p",item.groups.join(" / ")+" ／ "+(item.enabled?"利用中":"停止中"));
      button(box,"全端末からログアウト",async()=>{if(confirm("このスタッフの全セッションを終了しますか？")){await action({action:"logoutUser",sub:item.sub,expectedVersion:item.version});await load("users");}});
      if(item.enabled)button(box,"アカウント停止",async()=>{if(confirm("このスタッフの利用を停止しますか？")){await action({action:"disableUser",sub:item.sub,expectedVersion:item.version});await load("users");}},"danger");
      else button(box,'利用を再開',async()=>{if(confirm('本人確認は済んでいますか？ 利用を再開します。以前のセッションは無効のままです。')){await action({action:'enableUser',sub:item.sub,expectedVersion:item.version});await load('users');}});
    }else{events.push(item);add(box,"p",date(item.at)+" ／ "+item.event+" ／ "+item.result+" ／ "+item.ip);}
  }
  if(!r.items.length&&!more)add(area,"p","該当する記録はありません。");
  if(kind==="events")element("export-events").hidden=false;
}
element("login-form").onsubmit=e=>{e.preventDefault();run(()=>login("passkey"));};
element("password-login").onclick=()=>run(()=>login("password"));
element("passkey-again").onclick=()=>run(()=>login("passkey"));
element("refresh-status").onclick=()=>run(refresh);
element("enroll").onclick=()=>run(async()=>{
  const r=await action({action:"enrollStart"}),c=await navigator.credentials.create({publicKey:options(r.options,true)}) as PublicKeyCredential|null;
  if(!c)throw new Error("LOGIN_FAILED");
  await action({action:"enrollFinish",credential:credential(c)});await login("passkey");
});
element("logout").onclick=()=>run(async()=>{await action({action:"logout"});location.reload();});
element("probe").onclick=()=>run(async()=>{await action({action:"businessProbe"});if(document.body.dataset.business==="1"){
  const target=new URLSearchParams(location.search).get("returnTo")||"/inventory";
  location.assign(target.startsWith("/")&&!target.startsWith("//")&&!target.includes("\\")?target:"/inventory");return;
}element("probe-result").textContent="本人認証・暗号鍵・端末承認・権限の確認に成功しました。（本番データへの接続は行っていません）";});
element("reload-devices").onclick=()=>run(()=>load("devices"));
for(const kind of ["devices","users","events"] as const)element("more-"+kind).onclick=()=>run(()=>load(kind,true));
element("load-events").onclick=()=>run(()=>load("events"));
element<HTMLFormElement>('create-staff-form').onsubmit=event=>{event.preventDefault();run(async()=>{
  const result=await action({action:'createUser',username:input('staff-email').value,role:element<HTMLSelectElement>('staff-role').value,personConfirmed:input('staff-confirmed').checked});
  input('staff-temporary-password').value=result.temporaryPassword;input('staff-temporary-password').type='password';element('staff-created').hidden=false;input('staff-email').value='';input('staff-confirmed').checked=false;
  setTimeout(()=>{input('staff-temporary-password').value='';element('staff-created').hidden=true;},300000);await load('users');
});};
element('show-staff-password').onclick=()=>{input('staff-temporary-password').type=input('staff-temporary-password').type==='password'?'text':'password';};
element('close-staff-password').onclick=()=>{input('staff-temporary-password').value='';element('staff-created').hidden=true;};
element("export-events").onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(events,null,2)],{type:"application/json"}));const a=document.createElement("a");a.href=url;a.download="BELLO-access-events.json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
element("new-device").onclick=()=>run(async()=>{if(!confirm("新しい端末登録を申請します。管理者の再承認が必要です。よろしいですか？"))return;try{await action({action:"logout"});}catch(e){if(!isTerminalSessionError((e as Error).message))throw e;}keyPair=await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},false,["sign","verify"]);await saved("keyPair",keyPair);await saved('requestBinding','');location.reload();});
run(async()=>{
  keyPair=await saved<CryptoKeyPair>("keyPair")??await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},false,["sign","verify"]);
  await saved("keyPair",keyPair);username=await saved<string>("username")??"";input("username").value=username;
  if(document.body.dataset.business==="1"&&new URLSearchParams(location.search).get("logout")==="1"){
    try{await action({action:"logout"});}catch(e){if(!isTerminalSessionError((e as Error).message))throw e;}await saved("requestBinding","");history.replaceState(null,"","/security");
  }
  try{await refresh();}catch(e){element("login").hidden=false;if(!["SIGN_IN_REQUIRED","SESSION_EXPIRED"].includes((e as Error).message))throw e;}
});
