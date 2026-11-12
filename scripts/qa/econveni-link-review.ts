import {readFileSync,writeFileSync} from 'node:fs';
import {S3Client,GetObjectCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {titleWithoutNotes} from '../../lib/listing/econveni/manualSyncModel';
async function main(){
 const dir='artifacts/econveni-parity-20261112',data=JSON.parse(readFileSync(dir+'/link-audit.json','utf8'));
 const storage=JSON.parse(readFileSync('../bello-pc-mobile-parity-20261110/amplify_outputs.json','utf8')).storage;
 if(process.argv.includes('--extra')){
  data.unlinked[27].candidates=data.stocks.filter((s:any)=>/DEJA-VU/.test(s.name)).map((item:any)=>({item,score:1}));
  data.unlinked[28].candidates=data.stocks.filter((s:any)=>/Adelaide/.test(s.name)&&(s.quantity>0||['2026-10-29','2026-10-11','2026-10-05'].includes(s.saleEndDate))).map((item:any)=>({item,score:1}));
 }
 if(process.argv.includes('--split')){
  data.unlinked=[{...data.unlinked[23],candidates:[{item:data.stocks.find((s:any)=>s.id==='3745ca7b-20b6-4c44-a4ed-8c4943a4a92a'),score:1}]},{...data.unlinked[26],candidates:[{item:data.stocks.find((s:any)=>s.id==='57b4b2b5-d6ad-435a-b303-5d412405a44c'),score:1}]}];
 }
 const s3=new S3Client({region:storage.aws_region});const esc=(x:any)=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
 let html='<!doctype html><meta charset="utf-8"><style>body{font:16px system-ui;margin:20px;background:#f3f5f5}section{background:white;padding:20px;margin:30px 0;scroll-margin-top:0}h2{margin:0 0 12px;font-size:20px} .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.card{padding:12px;border:1px solid #ddd}.card img{width:100%;height:210px;object-fit:contain}.name{font-size:14px;line-height:1.4}.ref{background:#e4f1ee}small{color:#555}a{margin-right:10px}</style><h1>eコンビニ・在庫 写真照合</h1>';
 html+=data.unlinked.map((r:any,i:number)=>'<a href="#p'+i+'">'+i+'</a>').join('');
 for(const [i,r] of data.unlinked.entries()){
  const primary=data.data.snapshot.products.find((p:any)=>p.productId===(i===0?'10142522':'10109177'));
  const cards=[{label:'eコンビニ '+r.product.productId,image:r.product.imageUrl,name:r.product.title},...(process.argv.includes('--split')?[{label:'紐付け済みの別ページ '+primary.productId,image:primary.imageUrl,name:primary.title}]:[]),...await Promise.all(r.candidates.map(async(c:any,n:number)=>{const img=(c.item.images??[]).find((v:any)=>v.isPrimary)??c.item.images?.[0];const key=img?.thumbnailKey??img?.storageKey;return {label:'候補'+n+' / '+(c.item.categories??[]).join('・')+' / '+(c.item.quantity??0)+'点',name:titleWithoutNotes(c.item.name),image:key?await getSignedUrl(s3,new GetObjectCommand({Bucket:storage.bucket_name,Key:key}),{expiresIn:3600}):'',id:c.item.id,score:c.score};}))];
  html+='<section id="p'+i+'"><h2>'+i+' : '+esc(r.product.title)+'</h2><div class="grid">'+cards.map((c:any,n:number)=>'<div class="card '+(!n?'ref':'')+'"><b>'+esc(c.label)+'</b><img src="'+esc(c.image)+'"><p class="name">'+esc(c.name)+'</p><small>'+esc(c.id??'')+' '+(c.score?.toFixed(3)??'')+'</small></div>').join('')+'</div></section>';
 }
 writeFileSync(dir+'/link-review.html',html);console.log('Review ready: '+data.unlinked.length+' products');
}main().catch(()=>{console.error('REVIEW_FAILED');process.exitCode=1;});
