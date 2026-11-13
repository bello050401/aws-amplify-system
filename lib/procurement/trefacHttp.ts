import 'server-only';
import {SecretsManagerClient,GetSecretValueCommand} from '@aws-sdk/client-secrets-manager';
import {trefacLot,trefacAfterBoundary,TREFAC_BOUNDARY} from './trefac';
const ROOT='projects/live-net-auction/databases/(default)/documents';
type FirestoreValue={stringValue?:string;integerValue?:string;doubleValue?:number;booleanValue?:boolean;timestampValue?:string;referenceValue?:string;arrayValue?:{values?:FirestoreValue[]};mapValue?:{fields?:Record<string,FirestoreValue>}};
type FirestoreDocument={name:string;fields?:Record<string,FirestoreValue>};
const decode=(v:FirestoreValue):unknown=>v.stringValue??(v.integerValue!==undefined?Number(v.integerValue):v.doubleValue??v.booleanValue??v.timestampValue??v.referenceValue??(v.arrayValue?(v.arrayValue.values||[]).map(decode):v.mapValue?Object.fromEntries(Object.entries(v.mapValue.fields||{}).map(([k,v])=>[k,decode(v)])):null));
const document=(d:FirestoreDocument):Record<string,unknown>=>({id:String(d.name).split('/').pop(),...Object.fromEntries(Object.entries(d.fields||{}).map(([k,v])=>[k,decode(v)]))});
async function json(url:string,init:RequestInit){const r=await fetch(url,{...init,signal:AbortSignal.timeout(20000),redirect:'error',cache:'no-store'});if(!r.ok)throw Error('トレファクの取得に失敗しました（'+r.status+'）。ログイン・接続状況を確認してください。');return r.json();}
export class TrefacHttp{
 private token='';account='';
 async login(email:string,password:string){
  const a=await json('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=AIzaSyDXNKKEBY-iECgzzCrzjrpS66N9AVepcAE',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password,returnSecureToken:true})});
  if(!a.idToken||!a.localId)throw Error('トレファクのログインを確認できません。');this.token=a.idToken;this.account=a.localId;
  const vendor=await this.read('vendors/'+this.account);if(vendor.available!==true||vendor.leaved===true)throw Error('トレファクの利用アカウントを確認してください。');
 }
 private headers(){if(!this.token)throw Error('トレファクに接続してください。');return{Authorization:'Bearer '+this.token,'content-type':'application/json'};}
 private async read(path:string){if(!/^(items|vendors)\/[A-Za-z0-9_-]+$/.test(path))throw Error('取得先が不正です。');return document(await json('https://firestore.googleapis.com/v1/'+ROOT+'/'+path,{headers:this.headers()}));}
 private own(row:Record<string,unknown>){return row.buyer_vendor_id_ref===ROOT+'/vendors/'+this.account;}
 async fetchLots(){
  const anchor=await this.read('items/'+TREFAC_BOUNDARY.documentId);
  if(!this.own(anchor)||anchor.count!==TREFAC_BOUNDARY.goodsId||anchor.dispnum!==TREFAC_BOUNDARY.lotNumber||!trefacAfterBoundary(anchor,anchor))throw Error('指定した開始商品を照合できません。取込を停止しました。');
  // Authenticated own-wins query; never search another seller's account data.
  const data=await json('https://firestore.googleapis.com/v1/'+ROOT+':runQuery',{method:'POST',headers:this.headers(),body:JSON.stringify({structuredQuery:{from:[{collectionId:'items'}],where:{fieldFilter:{field:{fieldPath:'buyer_vendor_id_ref'},op:'EQUAL',value:{referenceValue:ROOT+'/vendors/'+this.account}}},limit:1001}})});
  if(!Array.isArray(data))throw Error('落札一覧を確認できません。');
  const rows=data.filter(d=>d.document).map(d=>document(d.document));if(rows.length>=1001)throw Error('落札一覧が取得上限を超えました。取りこぼしを避けるため登録を止めています。');
  if(rows.some(r=>!this.own(r)))throw Error('落札者の照合に失敗しました。');
  return rows.filter(r=>trefacAfterBoundary(r,anchor)&&r.status==='落札'&&!r.return_requested).map(r=>trefacLot(r,this.account)).sort((a,b)=>a.soldAt.localeCompare(b.soldAt)||a.lotNumber-b.lotNumber);
 }
 async verify(id:string){const r=await this.read('items/'+id);if(!this.own(r)||!trefacAfterBoundary(r,{saledate:TREFAC_BOUNDARY.earliest}))throw Error('対象商品の落札者・取込開始日時が一致しません。');return trefacLot(r,this.account);}
 async image(url:string){
  const u=new URL(url);if(u.protocol!=='https:'||u.hostname!=='firebasestorage.googleapis.com'||!u.pathname.startsWith('/v0/b/live-net-auction.appspot.com/o/products%2F')||u.username||u.password)throw Error('商品写真の取得先を確認できません。');
  const r=await fetch(u,{redirect:'error',signal:AbortSignal.timeout(25000),cache:'no-store'});if(!r.ok||Number(r.headers.get('content-length'))>15000000)throw Error('商品写真を取得できません。');
  const reader=r.body?.getReader();if(!reader)throw Error('商品写真が空です。');const chunks:Uint8Array[]=[];let size=0;try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>15000000)throw Error('商品写真が大きすぎます。');chunks.push(value);}}finally{await reader.cancel();}
  const bytes=Buffer.concat(chunks),sharp=(await import('sharp')).default,m=await sharp(bytes,{limitInputPixels:40000000}).metadata();if(!['jpeg','png','webp'].includes(m.format||''))throw Error('商品写真の形式を確認できません。');return{bytes,mime:'image/'+m.format,ext:m.format==='jpeg'?'.jpg':'.'+m.format};
 }
}
let cached:{client:TrefacHttp;until:number}|undefined;
export async function trefacConnection(){if(cached&&cached.until>Date.now())return cached.client;const s=await new SecretsManagerClient({region:'us-west-2'}).send(new GetSecretValueCommand({SecretId:'bello/trefac-readonly-credentials'})),c=JSON.parse(s.SecretString||'{}');if(!c.email||!c.password)throw Error('トレファクのログイン情報が未設定です。');const client=new TrefacHttp();await client.login(c.email,c.password);cached={client,until:Date.now()+240000};return client;}
