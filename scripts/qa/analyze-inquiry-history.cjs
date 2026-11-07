const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const dir=path.resolve(process.argv[2]||'artifacts/whole-instruction-20261107/mercari-history-private');
const groups={};for(let p=1;p<=5;p++)groups[p]=JSON.parse(fs.readFileSync(path.join(dir,'list-'+p+'.json'),'utf8'));
const heldout=new Set(groups[4].map(r=>r.id));
const tags={dimensions:/寸法|サイズ|[0-9]\s*(?:cm|mm)|幅|奥行|座面|何人掛|[23]P/i,price:/値下|お値引|値引|価格|金額|送料込/,delivery:/配送|発送|搬入|階段|設置|送料|日時|日付|着日|届け/,condition:/傷|キズ|汚れ|不具合|欠品|補修|状態/,receipt:/領収|請求書|インボイス/,quantity:/在庫|何点|何脚|セット|まとめて/,product:/商品名|型番|ブランド|モデル|正規|本物|カラー|色|素材|材質/};
const dataset=[],metrics={conversations:0,messages:0,buyerMessages:0,staffMessages:0,counts:{},missingMessages:[],heldout:heldout.size,fullyExpanded:true};
for(const [page,rows]of Object.entries(groups))for(const row of rows){
 const text=fs.readFileSync(path.join(dir,row.id+'.txt'),'utf8');
 if(text.includes('- button "もっと見る"'))metrics.fullyExpanded=false;
 // Evaluation-only cases remain unopened by the analysis parser.
 if(heldout.has(row.id))continue;
 const section=text.split('- heading "メッセージ内容" [level=2]')[1]?.split('- textbox')[0]?.split('- heading "メッセージ概要"')[0]||'';
 const matches=[...section.matchAll(/^- paragraph: (.*)$/gm)];const ps=matches.map(m=>m[1].trim());
 const messages=[];
 for(let i=2;i<ps.length;i++)if(/^\d{4}年\d{1,2}月\d{1,2}日 \d{1,2}:\d{2}$/.test(ps[i]))messages.push({speaker:ps[i-2]==='オーナー'||section.slice(matches[i].index+matches[i][0].length,matches[i+1]?.index??section.length).includes('img \"Seller Avatar\"')?'STAFF':'BUYER',body:ps[i-1],sentAt:ps[i]});
 if(!messages.length)metrics.missingMessages.push(row.id);
 const customer=messages.filter(m=>m.speaker==='BUYER').map(m=>m.body.normalize('NFKC')).join('\n');
 const categories=Object.entries(tags).filter(([,re])=>re.test(customer)).map(([key])=>key);
 for(const c of categories)metrics.counts[c]=(metrics.counts[c]||0)+1;
 metrics.conversations++;metrics.messages+=messages.length;metrics.buyerMessages+=messages.filter(m=>m.speaker==='BUYER').length;metrics.staffMessages+=messages.filter(m=>m.speaker==='STAFF').length;
 dataset.push({sourceId:row.id,sourceSha256:crypto.createHash('sha256').update(text).digest('hex'),page:Number(page),updatedAt:row.cells.at(-1),categories,messages,productId:text.match(/\/products\/([A-Za-z0-9_-]+)/)?.[1]??null});
}
fs.writeFileSync(path.join(dir,'analysis-private.json'),JSON.stringify(dataset,null,2));
fs.writeFileSync(path.join(dir,'heldout-manifest-private.json'),JSON.stringify({status:'AWAITING_BELLO_REVIEW',cases:[...heldout].map(id=>({id,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,id+'.txt'))).digest('hex'),reviewer:null,correctInventoryId:null,replyAcceptedWithoutFactEdit:null}))},null,2));
fs.writeFileSync(path.join(dir,'../history-analysis-summary.json'),JSON.stringify({...metrics,classification:'keyword-based descriptive analysis, not quality scoring',source:'実際のメルカリShops管理画面',evaluationStatus:'50件は調整用集計から除外。社員正解ラベル・返信品質評価は未実施。'},null,2));
console.log(JSON.stringify(metrics));
