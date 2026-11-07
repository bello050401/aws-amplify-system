import sharp from 'sharp';
import {TextractClient,AnalyzeDocumentCommand} from '@aws-sdk/client-textract';
import {BedrockRuntimeClient} from '@aws-sdk/client-bedrock-runtime';
import {sheetFromBlocks} from './textract';
import {reconcileReadings} from './restageOcr';
import {SHEET_MODELS,readVisualSheet,visualAsSheet,reconcileConditions} from './vision';
import {sha} from './sources';
import type {SourceIdentity} from './types';

/** Originals remain immutable. Redact the signer, preserving complete remarks
 * and table/diagram relationships instead of discarding content at crop edges. */
export async function readRestageSheet(bytes:Buffer,identity:SourceIdentity,url:string){
 const start=Date.now(),image=await sharp(bytes,{limitInputPixels:40_000_000}).rotate().jpeg({quality:98}).toBuffer(),meta=await sharp(image).metadata(),w=meta.width!,h=meta.height!;
 const ocr=new TextractClient({region:process.env.AWS_REGION||'us-west-2',maxAttempts:2});let textractPages=0;
 const native=async(b:Buffer)=>{textractPages++;const r=await ocr.send(new AnalyzeDocumentCommand({Document:{Bytes:b},FeatureTypes:['TABLES']}),{abortSignal:AbortSignal.timeout(45000)});if(!r.Blocks?.length)throw Error('OCR_EMPTY');return r.Blocks;};
 const center=await sharp(image).extract({left:0,top:Math.floor(h*.17),width:w,height:Math.floor(h*.70)}).toBuffer();
 const form=sheetFromBlocks(await native(center)).form;if(form==='UNKNOWN')throw Error('OCR_FORM_UNVERIFIED');
 const mask=form==='CHAIR'?{left:0,top:Math.floor(h*.945),width:w,height:h-Math.floor(h*.945)}:{left:Math.floor(w*.4),top:0,width:Math.floor(w*.34),height:Math.floor(h*.16)};
 const white=await sharp({create:{width:mask.width,height:mask.height,channels:3,background:'#fff'}}).png().toBuffer();
 const redacted=await sharp(image).composite([{input:white,left:mask.left,top:mask.top}]).jpeg({quality:98}).toBuffer();
 const layout=sheetFromBlocks(await native(redacted),form);if(layout.form!==form)throw Error('OCR_LAYOUT_MISMATCH');
 const client=new BedrockRuntimeClient({region:process.env.AWS_REGION||'us-west-2',maxAttempts:1});
 // Separate models and contexts: neither sees the other's answer.
 const normalized=await sharp(redacted).normalise().jpeg({quality:98}).toBuffer();
 const [first,second]=await Promise.all([readVisualSheet(client,SHEET_MODELS[0],redacted),readVisualSheet(client,SHEET_MODELS[1],normalized)]);
 const readings=[visualAsSheet(first.reading,layout),visualAsSheet(second.reading,layout)];
 const result=reconcileConditions(reconcileReadings(identity,url,sha(bytes),readings[0],readings[1]),first.reading,second.reading);
 result.source.blocks.push({id:'remarks-native',text:layout.remarks.text,heading:'備考の別読取（照合用）',kind:'other',region:layout.remarks.region,verified:false});
 result.source.blocks.push({id:'remarks-second',text:second.reading.remarks,heading:'備考の再読取（全文）',kind:'other',region:layout.remarks.region,verified:false});
 result.issues=[...new Set(result.issues)];
 return{result,readings,nativeReading:layout,visualReadings:[first,second],usage:{inputTokens:first.inputTokens+second.inputTokens,outputTokens:first.outputTokens+second.outputTokens,textractPages,ms:Date.now()-start,models:[...SHEET_MODELS]}};
}
