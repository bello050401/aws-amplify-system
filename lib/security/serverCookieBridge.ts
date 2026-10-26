import type {Tokens} from './types';
/** Mimic Next's encoded cookie-name lookup without ever setting browser cookies. */
export function serverCookieBridge(clientId:string,identity:{username:string;tokens:Tokens}|null){
 const prefix='CognitoIdentityServiceProvider.'+clientId+'.';
 const encode=(name:string)=>encodeURIComponent(name).replace(/%(2[346B]|5E|60|7C)/g,decodeURIComponent);
 const values=new Map<string,string>((identity?[
  [prefix+'LastAuthUser',identity.username],
  [prefix+identity.username+'.accessToken',identity.tokens.access],
  [prefix+identity.username+'.idToken',identity.tokens.id],
  [prefix+identity.username+'.clockDrift','0'],
 ]:[]).map(([key,value])=>[encode(key),value]));
 return{
  get:(name:string)=>values.has(name)?{name,value:values.get(name)!}:undefined,
  getAll:()=>[...values].map(([name,value])=>({name,value})),
  has:(name:string)=>values.has(name),
  set:()=>{throw Error('SERVER_ONLY_SESSION')},delete:()=>{throw Error('SERVER_ONLY_SESSION')},
  clear:()=>{throw Error('SERVER_ONLY_SESSION')},size:values.size,toString:()=>'',
 };
}
