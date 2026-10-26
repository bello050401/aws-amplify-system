import type {DeviceProofInput} from './deviceProof.mjs';
export type FileDescription={mimeType:string;fileSize:number;sha256:string};
export type Upload={uploadUrl:string;expectedMimeType:string;expectedBytes:number;expectedSha256:string;variant?:string};
export const NON_RETRYABLE_CODES:Set<string>;
export function describeFile(path:string,mimeType?:string):Promise<FileDescription>;
export class PhotoRegistrationApiClient {
 constructor(options:{endpoint:string;tokenProvider:()=>Promise<string>;deviceProofProvider?:(input:DeviceProofInput)=>Promise<Record<string,string>>;fetchImpl?:typeof fetch;retries?:number});
 call<T=Record<string,any>>(operation:string,input:unknown):Promise<T>;
 upload(upload:Upload,filePath:string):Promise<void>;
}
export function chunk<T>(items:T[],size?:number):T[][];
export function uploadSession(input:{api:PhotoRegistrationApiClient;deviceId:string;sdCardId?:string|null;sessionId?:string;assets:{clientAssetId?:string;fileName:string;originalPath?:string;originalArchiveId?:string;importedAt?:string;processedPath:string;thumbnailPath:string;processedDimensions:{width:number;height:number};thumbnailDimensions:{width:number;height:number}}[];onCheckpoint?:(checkpoint:Record<string,unknown>)=>Promise<void>}):Promise<{batchId:string;batchCode:string;uploaded:number;duplicateSkips:number}>;
