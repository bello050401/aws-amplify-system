import type {Block} from '@aws-sdk/client-textract';
import type {SheetReading} from './restageOcr';
import type {Region} from './types';
type Line={text:string;region:Region;confidence:number};
const lines=(blocks:Block[]):Line[]=>blocks.filter(b=>b.BlockType==='LINE'&&b.Text&&b.Geometry?.BoundingBox).map(b=>({text:b.Text!,confidence:b.Confidence||0,region:{x:b.Geometry!.BoundingBox!.Left!,y:b.Geometry!.BoundingBox!.Top!,width:b.Geometry!.BoundingBox!.Width!,height:b.Geometry!.BoundingBox!.Height!}}));
const union=(rows:Line[]):Region=>{if(!rows.length)return{x:0,y:0,width:1,height:1};const x=Math.min(...rows.map(r=>r.region.x)),y=Math.min(...rows.map(r=>r.region.y));return{x,y,width:Math.max(...rows.map(r=>r.region.x+r.region.width))-x,height:Math.max(...rows.map(r=>r.region.y+r.region.height))-y};};
const readingSection=(rows:Line[],complete=true)=>({text:rows.sort((a,b)=>Math.abs(a.region.y-b.region.y)<.012?a.region.x-b.region.x:a.region.y-b.region.y).map(r=>r.text).join('\n'),complete:complete&&rows.every(r=>r.confidence>=90),region:union(rows)});
export function sheetFromBlocks(blocks:Block[],formHint?:SheetReading['form']):SheetReading{
 const all=lines(blocks),allText=all.map(l=>l.text).join('\n');
 const form=/イス専用|状態図|例外メモ/.test(allText)?'CHAIR':/特記事項/.test(allText)&&/機能評価/.test(allText)?'GENERAL':formHint||'UNKNOWN';
 const sizeHeader=all.filter(l=>/サイズ|寸法\s*[(（]/.test(l.text)&&l.region.y<.45).sort((a,b)=>a.region.y-b.region.y)[0];
 let dimensionRows=sizeHeader?all.filter(l=>l!==sizeHeader&&l.region.y>=sizeHeader.region.y&&l.region.y<sizeHeader.region.y+.095&&l.region.x>=sizeHeader.region.x-.15&&/\d/.test(l.text)):[];
 if(form==='CHAIR'&&sizeHeader){
  const axes=all.filter(l=>/^[WDH]$/.test(l.text.trim())&&l.region.y>sizeHeader.region.y&&l.region.y<sizeHeader.region.y+.07);
  dimensionRows=axes.flatMap(label=>{const nextX=Math.min(1,...axes.filter(a=>a.region.x>label.region.x+.02).map(a=>a.region.x));const values=all.filter(l=>/^\d+(?:\.\d+)?$/.test(l.text.trim())&&l.region.x>=label.region.x-.005&&l.region.x<nextX&&l.region.y>=label.region.y-.01&&l.region.y<label.region.y+.035);return values.length===1?[{...values[0],text:label.text.trim()+' '+values[0].text,region:union([label,values[0]])}]:[];});
 }
 const heading=all.find(l=>/特記事項/.test(l.text)&&l.region.y>.60);
 const noteRows=form==='GENERAL'&&heading?all.filter(l=>l.region.y>heading.region.y+heading.region.height*.75):
  form==='CHAIR'?all.filter(l=>{const exception=all.find(x=>/例外メモ/.test(x.text));const inspection=all.find(x=>/検査員報告/.test(x.text));return (exception&&l.region.y>exception.region.y+exception.region.height*.8&&l.region.y<.945)||(inspection&&l.region.x<.35&&l.region.y>inspection.region.y+inspection.region.height&&l.region.y<.55);}):[];
 let measurement:SheetReading['measurement']=form==='GENERAL'?'PRODUCT':'UNKNOWN';
 if(form==='CHAIR'){
  const selected=blocks.filter(b=>b.BlockType==='SELECTION_ELEMENT'&&b.SelectionStatus==='SELECTED'&&b.Geometry?.BoundingBox);
  const checked=(text:string)=>all.some(l=>l.text.includes(text)&&selected.some(b=>{const r=b.Geometry!.BoundingBox!;return Math.abs((r.Top!+r.Height!/2)-(l.region.y+l.region.height/2))<.018&&r.Left!>=l.region.x-.10&&r.Left!<l.region.x+.08;}));
  if(checked('実寸法')&&!checked('積載寸法'))measurement='PRODUCT';
  if(checked('積載寸法')&&!checked('実寸法'))measurement='STACKED';
 }
 const unit=(sizeHeader?.text.match(/\b(mm|cm|m)\b/i)?.[1]?.toLowerCase()||null) as SheetReading['unit'];
 const multipleProducts=all.filter(l=>/^商品名|ロット番号/.test(l.text)).length>1;
 const dimensions=readingSection(dimensionRows,!!sizeHeader),remarks=readingSection(noteRows,form==='CHAIR'||!!heading);
 if(sizeHeader)dimensions.region={x:form==='CHAIR'?.38:Math.max(0,sizeHeader.region.x-.03),y:Math.max(0,sizeHeader.region.y-.02),width:form==='CHAIR'?.45:Math.min(.58,1-Math.max(0,sizeHeader.region.x-.03)),height:.12};
 if(form==='GENERAL'&&heading)remarks.region={x:.025,y:heading.region.y,width:.95,height:1-heading.region.y};
 return{form,multipleProducts,lotNumber:null,measurement,unit,dimensions,remarks,condition:{text:'',complete:false,region:{x:.02,y:.3,width:.96,height:.6}}};
}
