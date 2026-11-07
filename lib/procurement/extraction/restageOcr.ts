import {extractDimensions} from './dimensions';
import type {SourceIdentity,SourceDocument,Region,ExtractionResult} from './types';

export const RESTAGE_OCR_MODEL='qwen.qwen3-vl-235b-a22b';
// Confirmed by BELLO on 2026-11-07: the general form's W715 means 715 mm,
// and must be written to BELLO's centimetre field as 71.5. Explicit units win.
export const GENERAL_FORM_DEFAULT_UNIT='mm';
type Section={text:string;complete:boolean;region:Region};
export type SheetReading={form:'CHAIR'|'GENERAL'|'UNKNOWN';multipleProducts:boolean;lotNumber:string|null;
 measurement:'PRODUCT'|'STACKED'|'UNKNOWN';unit:'mm'|'cm'|'m'|null;
 dimensions:Section;remarks:Section;condition:Section};
const comparable=(s:string)=>s.normalize('NFKC').replace(/\s+/g,'').replace(/[、,，]/g,'、');
/** Two independent readings. The second receives crops, never first-pass values.
 * Agreement is an additional check, not proof of correctness; release gates remain external. */
export function reconcileReadings(identity:SourceIdentity,url:string,hash:string,a:SheetReading,b:SheetReading):ExtractionResult{
 const issues:string[]=[];
 const recognized=a.form===b.form&&a.form!=='UNKNOWN';
 const lotMismatch=[a,b].some(v=>v.lotNumber&&v.lotNumber!==identity.lotNumber);
 const targetVerified=recognized&&!a.multipleProducts&&!b.multipleProducts&&!lotMismatch;
 if(!recognized)issues.push('出品表の形式を確定できません');
 if(a.multipleProducts||b.multipleProducts)issues.push('同一資料に複数商品があります。対象行を確認してください');
 if(lotMismatch)issues.push('資料のロット番号が取得対象と一致しません');
 const ua=a.unit||(a.form==='GENERAL'?GENERAL_FORM_DEFAULT_UNIT:null),ub=b.unit||(b.form==='GENERAL'?GENERAL_FORM_DEFAULT_UNIT:null);
 const unit=ua===ub?ua:null;
 const measure=recognized&&a.form==='GENERAL'?'PRODUCT':a.measurement===b.measurement?a.measurement:'UNKNOWN';
 const blocks=(['dimensions','remarks','condition'] as const).map(kind=>{
  const x=a[kind],y=b[kind],verified=x.complete&&y.complete&&comparable(x.text)===comparable(y.text);
  if(!verified)issues.push(`${kind==='dimensions'?'寸法':kind==='remarks'?'備考・特記事項':'状態'}：再読取と一致しない、または判読不能な箇所があります`);
  return{id:kind,text:x.text,heading:kind==='dimensions'?(measure==='STACKED'?'積載寸法':measure==='UNKNOWN'?'対象未確定の寸法':'商品寸法')+(unit?`（${unit}）`:''):kind==='remarks'?'備考・特記事項':'状態',kind,region:x.region,imageId:hash,page:1,verified};
 });
 const source:SourceDocument={identity,url,hash,format:recognized?`restage-${a.form.toLowerCase()}-v1`:'unverified',acquiredAt:new Date().toISOString(),complete:true,targetVerified,blocks,issues};
 if(a.form==='GENERAL'&&a.unit===null&&b.unit===null)source.unitPolicy='2026-11-07 BELLO確認：汎用票の単位未記載715は715mm、BELLOのcm欄へ71.5として換算';
 // Keep the untouched transcription in evidence; an explicit common-unit header
 // is inserted only for parsing, never appended to the verbatim remarks.
 const parseSource={...source,blocks:blocks.flatMap(block=>block.kind==='dimensions'?[{...block,id:'dimension-header',text:`寸法${unit?'（'+unit+'）':''}`},block]:[block])};
 const result=extractDimensions(parseSource);result.source=source;
 // A disagreement about one number must not block other clear axes. Compare
 // each axis independently, retaining the first transcription and its region.
 if(targetVerified&&measure==='PRODUCT'&&unit&&a.dimensions.complete&&b.dimensions.complete&&!blocks[0].verified){
  const axisRead=(v:SheetReading)=>extractDimensions({...source,blocks:[{id:'unit',text:`寸法（${unit}）`,verified:true},{...blocks[0],text:v.dimensions.text,verified:true}]}).dimensions;
  const aa=axisRead(a),bb=axisRead(b);
  for(const d of result.dimensions.filter(d=>d.blockId==='dimensions'&&d.reason==='原資料との照合待ち')){
   const x=aa.filter(c=>c.axis===d.axis),y=bb.filter(c=>c.axis===d.axis);
   if(x.length===1&&y.length===1&&x[0].disposition==='ACCEPT'&&y[0].disposition==='ACCEPT'&&x[0].mm===y[0].mm&&x[0].condition===y[0].condition){d.disposition='ACCEPT';d.reason=undefined;}
  }
 }
 if(measure==='UNKNOWN')result.dimensions.forEach(d=>{if(d.disposition!=='EXCLUDE'){d.disposition='REVIEW';d.reason='実寸法か積載寸法か未確定です';}});
 result.remarks=blocks.filter(b=>b.kind==='remarks'&&b.text).map(b=>({blockId:b.id,text:b.text,disposition:b.verified&&targetVerified?'ACCEPT':'REVIEW',reason:b.verified?undefined:'原画像と全文を確認してください'}));
 result.defects=blocks.filter(b=>b.kind==='condition'&&b.text).map(b=>({id:b.id,blockId:b.id,text:b.text,disposition:b.verified&&targetVerified?'ACCEPT':'REVIEW'}));
 // Long remarks are always retained verbatim, even when their dimensions cannot
 // be split into simple axes. Never use unknown measurement context for fields.
 return result;
}
/** Independent OCR must corroborate the complete remarks, not confidence alone. */
export function crossCheckRemarks(result:ExtractionResult,native:SheetReading){
 const normalize=(s:string)=>s.normalize('NFKC').replace(/[\s、,，・。.:：]/g,'');
 if(result.remarks?.length&&(!native.remarks.complete||normalize(result.remarks[0].text)!==normalize(native.remarks.text))){
  result.remarks.forEach(r=>{r.disposition='REVIEW';r.reason='独立した文字認識と一致しません。原本の全文を確認してください';});
  result.issues.push('備考の文字認識が一致しません。原資料を見て修正してください');
 }
 result.source.blocks.push({id:'remarks-independent',text:native.remarks.text,heading:'備考の別読取（照合用）',kind:'other',region:native.remarks.region,verified:false});
 return result;
}
