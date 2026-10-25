export const ORIGINAL_RETENTION_MS=7*24*60*60*1000;
export const MAX_ORIGINAL_BYTES=100*1024*1024;
export interface PhotoOriginal {
 key:string;fileName:string;mimeType:string;fileSize:number;sha256:string;
 expiresAt:string;requestedAt:string;uploadedAt?:string;retentionStartedAt?:string;purgedAt?:string;purgeRecheckedAt?:string;retentionPolicy?:'PRODUCT_LINK';
}
export const originalObjectKey=(batchId:string,assetId:string)=>'photo-batches/originals/'+batchId+'/'+assetId+'.bin';
export function originalAvailable(original:PhotoOriginal|undefined,now=Date.now()){
 return !!original?.uploadedAt&&!original.purgedAt&&((original.retentionPolicy==='PRODUCT_LINK'&&!original.expiresAt)||Date.parse(original.expiresAt)>now);
}
/** The batch's immutable first product link is the retention clock, not upload or re-edit. */
export function originalForBatch(original:PhotoOriginal|undefined,linkedAt?:string|null):PhotoOriginal|undefined{
 if(!original||original.purgedAt)return original;
 const linked=Date.parse(linkedAt??'');
 return {...original,retentionPolicy:'PRODUCT_LINK',retentionStartedAt:Number.isFinite(linked)?linkedAt!:undefined,expiresAt:Number.isFinite(linked)?new Date(linked+ORIGINAL_RETENTION_MS).toISOString():''};
}
export function originalUrlTtl(original:PhotoOriginal,maximum:number,now=Date.now()){
 return original.expiresAt?Math.max(1,Math.min(maximum,Math.floor((Date.parse(original.expiresAt)-now)/1000))):maximum;
}
export function validOriginalDeclaration(input:Partial<PhotoOriginal>){
 return typeof input.fileName==='string'&&input.fileName.length>0&&input.fileName.length<=240&&!/[\\/\u0000-\u001f\u007f]/.test(input.fileName)&&
 /\.(jpe?g|png|webp|heic|heif|tiff?|arw|cr2|cr3|nef|dng|orf|rw2)$/i.test(input.fileName)&&
 typeof input.sha256==='string'&&/^[a-f0-9]{64}$/.test(input.sha256)&&
 Number.isSafeInteger(input.fileSize)&&Number(input.fileSize)>0&&Number(input.fileSize)<=MAX_ORIGINAL_BYTES;
}
