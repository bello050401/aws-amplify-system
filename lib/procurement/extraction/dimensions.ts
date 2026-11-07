import {EXTRACTION_VERSION,type Axis,type DimensionCandidate,type SourceDocument,type ExtractionResult} from './types';
const axisNames:Record<string,Axis>={幅:'width',横幅:'width',W:'width',奥行:'depth',奥行き:'depth',D:'depth',高さ:'height',高:'height',H:'height',全長:'overallLength',長さ:'overallLength',L:'overallLength',直径:'diameter','φ':'diameter','Φ':'diameter','Ø':'diameter',SH:'seatHeight',座面高:'seatHeight',AH:'armHeight',肘高:'armHeight',座面幅:'seatWidth',座面奥行:'seatDepth',天板厚:'thickness',厚み:'thickness',厚さ:'thickness',棚内幅:'innerWidth',棚内奥行:'innerDepth',棚内高さ:'innerHeight',脚間:'legGap'};
const labels=Object.keys(axisNames).sort((a,b)=>b.length-a.length).join('|');
const labelRe=new RegExp(`(${labels})`,'gi');
const valueRe=new RegExp(`(${labels})\\s*[:：=]?\\s*(?:[（(](mm|cm|m)[)）]\\s*)?(約\\s*)?(\\d+(?:\\.\\d+)?)(?:\\s*(?:~|〜|～|－|-)\\s*(\\d+(?:\\.\\d+)?))?\\s*(mm|cm|m)?`,'gi');
const packaging=/梱包|積載|発送サイズ|配送サイズ|三辺合計|[ABCDEFＳＬＭ]ランク|送料表|配送表|配送ランク/;
const conditional=/伸長時|伸張時|拡張時|最大|最小|折りたたみ|折畳|脚を外|脚なし|収納時|可動時|リクライニング時/;
const units=(u:string)=>u.toLowerCase()==='cm'?10:u.toLowerCase()==='m'?1000:1;
const axis=(s:string)=>axisNames[s]||axisNames[s.toUpperCase()];
const categories=['テーブル','チェア','椅子','スツール','ソファ','棚','キャビネット','照明'];
function scopeSegments(text:string){return text.split(/\s*[／/]\s*|[\n；;]/).filter(Boolean);}
/** Deterministic parser: no inference of order, unit, product or missing values. */
export function extractDimensions(source:SourceDocument):ExtractionResult{
  const candidates:DimensionCandidate[]=[],issues=[...source.issues];
  let tableHeader:{table:string;axes:Axis[];unit:string}|undefined,sectionUnit:string|undefined,section='';
  const allKinds=new Set(source.blocks.flatMap(b=>categories.filter(k=>b.text.startsWith(k)||new RegExp('(?:^|[、/／])\\s*'+k+'[：:\\s]').test(b.text))));
  const multi=allKinds.size>1&&!(allKinds.size===2&&allKinds.has('チェア')&&allKinds.has('椅子'));
  for(const b of source.blocks){
    const normalized=b.text.normalize('NFKC');
    if(/^(?:[■●【\s]*)?(?:サイズ|実寸|寸法|商品寸法|商品サイズ)[】\s:(（]*((?:mm|cm|m))?[)）\s]*$/i.test(normalized)){
      section='寸法';sectionUnit=normalized.match(/\b(mm|cm|m)\b/i)?.[1];continue;
    }
    if(/^[■●【]/.test(normalized)&&!/寸法|サイズ/.test(normalized)){section=normalized;sectionUnit=undefined;}
    if(b.cells&&b.cells.length>1){
      const headerAxes=b.cells.map(c=>axis(c.normalize('NFKC').replace(/[（(](?:mm|cm|m)[)）]/gi,'').trim()));
      const unit=b.text.match(/(?:\(|（)\s*(mm|cm|m)\s*(?:\)|）)/i)?.[1];
      if(headerAxes.every(Boolean)&&unit&&new Set(headerAxes).size===headerAxes.length){tableHeader={table:b.table||'',axes:headerAxes,unit};continue;}
      if(tableHeader&&tableHeader.table===b.table&&b.cells.length===tableHeader.axes.length&&b.cells.every(c=>/^\s*\d+(?:\.\d+)?\s*(?:mm|cm|m)?\s*$/i.test(c))){
        b.cells.forEach((c,i)=>{const m=c.match(/(\d+(?:\.\d+)?)\s*(mm|cm|m)?/i)!;const u=m[2]||tableHeader!.unit;push(tableHeader!.axes[i],Number(m[1]),u,c,'',b.text.indexOf(c),b.id,multi,undefined,b.verified);});continue;
      }
    }
    for(const s of scopeSegments(normalized)){
      const excluded=packaging.test(s)||packaging.test(b.heading||'')||packaging.test(section);
      const ordered=s.match(/^(.*?)[:：]\s*(\d+(?:\.\d+)?)\s*[×xX]\s*(\d+(?:\.\d+)?)\s*[×xX]\s*(\d+(?:\.\d+)?)\s*(mm|cm|m)\s*$/i);
      if(ordered&&!excluded){
        const order=[...ordered[1].matchAll(labelRe)].map(m=>axis(m[1]));
        if(order.length===3&&new Set(order).size===3){order.forEach((a,i)=>push(a,Number(ordered[i+2]),ordered[5],ordered[0],'',normalized.indexOf(s),b.id,multi,undefined,b.verified));continue;}
      }
      const matches=[...s.matchAll(valueRe)];
      // Unit at the end of one W/D/H group applies only within that group.
      const common=matches.length>1&&/^\s*(?:[×xX*,，、\s]|[()（）])*\s*$/.test(s.slice(matches[0].index!+matches[0][0].length,matches.at(-1)!.index!).replace(new RegExp(`(?:${labels})\\s*[:：=]?\\s*\\d+(?:\\.\\d+)?\\s*(?:mm|cm|m)?`,'gi'),''))?matches.at(-1)![6]:undefined;
      for(const m of matches){
        const ax=axis(m[1]);if(!ax)continue;
        // Avoid D/H in arbitrary English words or model codes.
        const prev=s[(m.index||0)-1];if(/[A-Za-z]/.test(m[1])&&prev&&/[A-Za-z0-9]/.test(prev))continue;
        const unit=m[6]||m[2]||common||sectionUnit;
        const condition=[m[3]?'約':'',m[5]?`${m[4]}〜${m[5]}`:'',s.match(conditional)?.[0]||''].filter(Boolean).join(' ');
        const part=/座面|肘|天板|棚内|脚間/.test(s.slice(0,m.index))&&!/seat|arm|inner|thickness|leg/.test(ax)?'部位未確定':'商品';
        push(ax,Number(m[4]),unit||null,m[0],condition,normalized.indexOf(s)+(m.index||0),b.id,multi,excluded?'配送・梱包・積載寸法':part!=='商品'?'部位を確認してください':undefined,b.verified);
      }
      if(!excluded&&!matches.length&&/\d+(?:\.\d+)?\s*[×xX]\s*\d+(?:\.\d+)?\s*[×xX]\s*\d/.test(s)){
        const order=[...s.matchAll(labelRe)].map(m=>axis(m[1]));const numbers=s.match(/(\d+(?:\.\d+)?)\s*[×xX]\s*(\d+(?:\.\d+)?)\s*[×xX]\s*(\d+(?:\.\d+)?)\s*(mm|cm|m)?/i)!;
        if(order.length===3&&new Set(order).size===3){order.forEach((a,i)=>push(a,Number(numbers[i+1]),numbers[4]||sectionUnit||null,numbers[0],'',normalized.indexOf(s)+numbers.index!,b.id,multi,undefined,b.verified));}
        else issues.push(`${b.id}：寸法の軸順を確認してください（${numbers[0]}）。`);
      }
    }
  }
  function push(ax:Axis,value:number,unit:string|null,raw:string,condition:string,start:number,blockId:string,multiple:boolean,reason?:string,verified?:boolean){
    const mm=unit?Number((value*units(unit)).toFixed(6)):null;
    const why=reason||(!unit?'単位を確認してください':value<=0||!Number.isFinite(mm)?'寸法値を確認してください':multiple?'複数商品の対象を確認してください':condition?'条件付きの寸法です':verified===false?'原資料との照合待ち':undefined);
    candidates.push({id:'d'+candidates.length,axis:ax,part:ax.startsWith('seat')?'座面':ax.startsWith('inner')?'内寸':'商品',raw,unit,value,mm,condition,blockId,start,end:start+raw.length,disposition:reason==='配送・梱包・積載寸法'?'EXCLUDE':why?'REVIEW':'ACCEPT',reason:why});
  }
  for(const ax of new Set(candidates.map(c=>c.axis))){
    const group=candidates.filter(c=>c.axis===ax&&c.disposition==='ACCEPT');
    if(new Set(group.map(c=>c.mm)).size>1)group.forEach(c=>{c.disposition='REVIEW';c.reason='同じ項目の記載値が競合しています';});
  }
  if(!source.targetVerified)candidates.filter(c=>c.disposition!=='EXCLUDE').forEach(c=>{c.disposition='REVIEW';c.reason='対象商品・行が未確定です';});
  const usable=candidates.filter(c=>c.disposition!=='EXCLUDE');
  return {version:EXTRACTION_VERSION,source,dimensions:candidates,defects:[],issues,state:!source.complete?'FAILED':!source.targetVerified?'REVIEW':!usable.length&&!issues.length?'NO_DIMENSIONS':'REVIEW'};
}
