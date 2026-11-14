import type {AcquisitionLot,InventoryMetadata,MetadataRow,ProductCategory,ProductKind,Taxonomy} from '../analysis/types';

export interface AnalysisMetadataView {
  categories:ProductCategory[];
  taxonomyRevision:number;
  current:MetadataRow|null;
}
export type AnalysisMetadataWrite =
  | {type:'taxonomy';value:Taxonomy;expectedRevision:number}
  | {type:'inventory';value:InventoryMetadata;expectedRevision:number}
  | {type:'kind';value:ProductKind;expectedRevision:number}
  | {type:'lot';value:AcquisitionLot;expectedRevision:number};

export interface AnalysisManagementPorts {
  read:(inventoryId?:string)=>Promise<
    | ({status:'ok'} & AnalysisMetadataView)
    | {status:'missing'|'error'}
  >;
  list:(request:{type:'kind'|'lot';cursor?:string})=>Promise<{status:'ok';rows:MetadataRow[];nextCursor:string|null}|{status:'error'}>;
  save:(request:AnalysisMetadataWrite)=>Promise<{status:'ok'|'conflict'|'invalid'|'error'}>;
}

