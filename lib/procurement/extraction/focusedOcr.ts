import sharp from 'sharp';
import {TextractClient,AnalyzeDocumentCommand} from '@aws-sdk/client-textract';
import {BedrockRuntimeClient} from '@aws-sdk/client-bedrock-runtime';
import {sheetFromBlocks} from './textract';
import {reconcileReadings} from './restageOcr';
import {SHEET_MODELS,readVisualSheet,readMeasurementMark,visualAsSheet,reconcileConditions} from './vision';
import {sha} from './sources';
import type {SourceIdentity} from './types';

/** Originals remain immutable. Redact the signer, preserving complete remarks
 * and table/diagram relationships instead of discarding content at crop edges. */
export async function readRestageSheet(bytes:Buffer,identity:SourceIdentity,url:string){
 const start=Date.now(),image=await sharp(bytes,{limitInputPixels:40_000_000}).rotate().jpeg({quality:98}).toBuffer(),meta=await sharp(image).metadata(),w=meta.width!,h=meta.height!;
 const ocr=new TextractClient({region:process.env.AWS_REGION||'us-west-2',maxAttempts:2});let textractPages=0;
 const native=async(b:Buffer)=>{textractPages++;const r=await ocr.send(new AnalyzeDocumentCommand({Document:{Bytes:b},FeatureTypes:['TABLES']}),{abortSignal:AbortSignal.timeout(45000)});if(!r.Blocks?.length)throw Error('OCR_EMPTY');return r.Blocks;};
 const center=await sharp(image).extract({left:0,top:Math.floor(h*.17),width:w,height:Math.floor(h*.70)}).toBuffer();
 let form=sheetFromBlocks(await native(center)).form;
 // The older general form has an English masthead. The centre crop omits it,
 // and Textract can miss its Japanese headings. Read just that printed corner;
 // the adjacent handwritten supplier/account box is deliberately excluded.
 if(form==='UNKNOWN'){
  const header=await sharp(image).extract({left:0,top:0,width:Math.floor(w*.4),height:Math.floor(h*.16)}).toBuffer();
  const text=(await native(header)).filter(b=>b.BlockType==='LINE').map(b=>b.Text||'').join(' ');
  if(/Real\s*Net\s*Auction/i.test(text))form='GENERAL';
 }
 if(form==='UNKNOWN')throw Error('OCR_FORM_UNVERIFIED');
 const mask=form==='CHAIR'?{left:0,top:Math.floor(h*.945),width:w,height:h-Math.floor(h*.945)}:{left:Math.floor(w*.4),top:0,width:Math.floor(w*.34),height:Math.floor(h*.16)};
 const white=await sharp({create:{width:mask.width,height:mask.height,channels:3,background:'#fff'}}).png().toBuffer();
 const redacted=await sharp(image).composite([{input:white,left:mask.left,top:mask.top}]).jpeg({quality:98}).toBuffer();
 const layout=sheetFromBlocks(await native(redacted),form);if(layout.form!==form)throw Error('OCR_LAYOUT_MISMATCH');
 const client=new BedrockRuntimeClient({region:process.env.AWS_REGION||'us-west-2',maxAttempts:1});
 // Separate models and contexts: neither sees the other's answer.
 const normalized=await sharp(redacted).normalise().jpeg({quality:98}).toBuffer();
 const [first,second]=await Promise.all([readVisualSheet(client,SHEET_MODELS[0],redacted),readVisualSheet(client,SHEET_MODELS[1],normalized)]);
 const readings=[visualAsSheet(first.reading,layout),visualAsSheet(second.reading,layout)];
 let markUsage={inputTokens:0,outputTokens:0};
 let markEvidence:{region:{x:number;y:number;width:number;height:number};readings:string[];accepted:boolean}|undefined;
 // Thin diagonal check marks disappear in whole-page recognition. Two fresh,
 // independent reads of the actual selector cells must agree before resolving.
 if(form==='CHAIR'&&(readings.some(r=>r.measurement==='UNKNOWN')||readings[0].measurement!==readings[1].measurement)){
  const region={x:.60,y:Math.max(0,layout.dimensions.region.y-.05),width:.39,height:.20};
  const crop=await sharp(redacted).extract({left:Math.floor(w*region.x),top:Math.floor(h*region.y),width:Math.floor(w*region.width),height:Math.min(Math.floor(h*region.height),h-Math.floor(h*region.y))}).resize({width:1400}).jpeg({quality:98}).toBuffer();
  const marks=await Promise.all(SHEET_MODELS.map(model=>readMeasurementMark(client,model,crop)));
  markUsage={inputTokens:marks.reduce((s,r)=>s+r.inputTokens,0),outputTokens:marks.reduce((s,r)=>s+r.outputTokens,0)};
  const accepted=marks[0].measurement!=='UNKNOWN'&&marks[0].measurement===marks[1].measurement&&readings.every(r=>r.measurement==='UNKNOWN'||r.measurement===marks[0].measurement);
  markEvidence={region,readings:marks.map(m=>m.measurement),accepted};
  if(accepted)readings.forEach(r=>r.measurement=marks[0].measurement);
 }
 const result=reconcileConditions(reconcileReadings(identity,url,sha(bytes),readings[0],readings[1]),first.reading,second.reading);
 if(markEvidence)result.source.blocks.push({id:'measurement-mark',text:markEvidence.readings.join(' / '),heading:'実寸法・積載寸法の選択欄（独立した2回の再読取）',kind:'other',region:markEvidence.region,imageId:sha(bytes),page:1,verified:markEvidence.accepted});
 result.source.blocks.push({id:'remarks-native',text:layout.remarks.text,heading:'備考の別読取（照合用）',kind:'other',region:layout.remarks.region,verified:false});
 result.source.blocks.push({id:'remarks-second',text:second.reading.remarks,heading:'備考の再読取（全文）',kind:'other',region:layout.remarks.region,verified:false});
 result.issues=[...new Set(result.issues)];
 return{result,readings,nativeReading:layout,visualReadings:[first,second],usage:{inputTokens:first.inputTokens+second.inputTokens+markUsage.inputTokens,outputTokens:first.outputTokens+second.outputTokens+markUsage.outputTokens,textractPages,ms:Date.now()-start,models:[...SHEET_MODELS]}};
}
