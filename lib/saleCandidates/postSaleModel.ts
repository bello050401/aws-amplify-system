import type {EcChannel,EcReview} from '../listing/ecManagement';
export type PostSaleRow={channel:EcChannel;externalId:string;operation:'STOP'|'STOCK';state:'READY'|'BLOCKED'|'DONE'|'VERIFY_REQUIRED';message:string;targetQuantity?:number;beforeQuantity?:number;unitsPerListing?:number;review?:EcReview};
export type PostSalePlan={id:string;candidateId:string;sourceId:string;sourceVersion:string;soldChannel:EcChannel|null;remaining:number;actor:string;expiresAt:number;rows:PostSaleRow[];state:'REVIEW'|'EXECUTING'|'COMPLETE'|'ATTENTION';token:string;updatedAt:string};
