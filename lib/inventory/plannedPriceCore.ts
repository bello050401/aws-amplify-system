import {createHash} from 'node:crypto';
import {parsePriceEntryChange,priceEntryCategoryIds,isPriceEntryTarget} from './plannedPrice';
import {parseCustomFields,stringifyCustomFields} from './customFieldsCodec';
import {withHumanEdits} from './humanEdits';
import {InventorySaveError,InventoryMutationRejected,assertInventoryVersion} from './conditionalUpdate';
export type PriceEntryRecord=Record<string,unknown> & {id:string;updatedAt:string;categoryId?:string|null;categoryIds?:string[]|null};
type Row=PriceEntryRecord;
export interface PriceEntryPort {get(id:string):Promise<Row|undefined>;categories():Promise<{id:string;name:string}[]>;save(row:Row,patch:Record<string,unknown>,actor:string):Promise<void>}
const receiptKey='__belloPlannedPriceWrite';
export async function savePlannedPrice(port:PriceEntryPort,raw:unknown,actor:string){
 const input=parsePriceEntryChange(raw);
 const fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');
 const applied=(row:Row|undefined)=>{const r=parseCustomFields(row?.customFields)?.[receiptKey] as Record<string,unknown>|undefined;return r?.actor===actor&&r?.fingerprint===fingerprint;};
 const row=await port.get(input.id);
 if(!row||row.deletedAt||row.listingPartition==='MERGED')throw new InventorySaveError('CONFLICT');
 if(applied(row))return row;
 assertInventoryVersion(input.expectedUpdatedAt,row.updatedAt);
 if(row.outboundBatchId)throw new InventoryMutationRejected('OUTBOUND_RESERVED');
 if(!isPriceEntryTarget(row,priceEntryCategoryIds(await port.categories())))throw new InventorySaveError('CONFLICT');
 const changes:Record<string,unknown>={};
 for(const key of ['name','note','plannedSalePrice'] as const)if((row[key]??(key==='note'?'':null))!==input[key])changes[key]=input[key];
 if(!Object.keys(changes).length)return row;
 const custom=parseCustomFields(row.customFields);
 const now=new Date(Math.max(Date.now(),Date.parse(row.updatedAt)+1)).toISOString();
 const patch={...changes,updatedAt:now,listUpdatedAt:now,updatedBy:actor,customFields:stringifyCustomFields({...withHumanEdits(row,changes,custom,custom??{}),[receiptKey]:{actor,fingerprint}})};
 try{await port.save(row,patch,actor);}catch(error){const latest=await port.get(input.id).catch(()=>undefined);if(applied(latest))return latest!;throw error;}
 const saved=await port.get(input.id);
 if(!applied(saved))throw new InventorySaveError('UNCONFIRMED');
 return saved!;
}
