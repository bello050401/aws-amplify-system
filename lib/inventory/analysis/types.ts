import type { ValueSource, InventoryValue } from '../inventoryValue';

export const ANALYSIS_VERSION = 1;
export const UNKNOWN = '__unknown__';
export type Confirmation = 'confirmed' | 'candidate' | 'unknown';
export type Band = '1' | '2-3' | '4-8' | '9+' | 'unknown';
export type Target = 'inventory' | 'sales' | 'acquisitions' | 'retailReference';
export type Metric = 'amount' | 'quantity' | 'kinds' | 'lots';
export type Dimension = 'category' | 'holding' | 'holdingBand' | 'lot' | 'lotBand';
export interface ProductCategory { id:string; label:string; mergedInto?:string }
export interface Taxonomy { type:'taxonomy'; categories:ProductCategory[] }
export interface ProductKind {
  type:'kind'; id:string; state:Confirmation; modelId:string|null; categoryId:string|null;
  specification:{brand:string; model:string; color:string; material:string; size:string; saleUnit:string};
}
export interface Evidence { source:string; recordId:string }
export interface InventoryMetadata {
  type:'inventory'; inventoryId:string;
  categoryId:string|null; categoryState:Confirmation;
  kindId:string|null; kindState:Confirmation;
  lotId:string|null; lotState:Confirmation;
  salesQuantity:number|null; salesQuantityEvidence:Evidence|null;
  retail:'confirmed'|'excluded'|'unknown';
  saleCostTotal:number|null; saleCostEvidence:Evidence|null;
}
/** ID = sourceKey(source, original source line ID), never an unscoped importer ID. */
export interface AcquisitionLot {
  type:'lot'; id:string; source:string; sourceRecordId:string; state:Confirmation;
  date:string; quantity:number|null; costTotal:number|null;
  categoryId:string|null; kindId:string|null;
  merchandise:boolean;
  operation:'acquisition'|'return'|'cancellation'; originalLotId:string|null;
}
export type Metadata = Taxonomy | ProductKind | InventoryMetadata | AcquisitionLot;
export interface MetadataRow { id:string; revision:number; value:Metadata }
export interface AnalysisSource extends ValueSource {
  name?:string|null; sku?:string|null; transactionDate?:string|null;
  salePrice?:number|null; sourceSystem?:string|null; sourceInventoryId?:string|null;
  customFields?:unknown; images?:unknown; market?:string|null;
}
export interface UnknownCounts {
  amount:number; cost:number; quantity:number; category:number; kind:number; lot:number;
  channel:number; origin:number; date:number;
}
export interface Totals {
  amount:number; gross:number; returns:number;
  quantity:number; grossQuantity:number; returnedQuantity:number; kinds:number; lots:number;
  records:number; unknown:UnknownCounts;
}
export interface Bucket extends Totals { key:string; label:string; color:string }
export interface Summary extends Totals {
  dimensions:Partial<Record<Dimension,Bucket[]>>;
}
/** Minimal immutable generation projection; images contain a storage reference only. */
export interface Fact {
  id:string; inventoryId:string|null; title:string; imageRef:string|null;
  date:string|null; category:string; kindId:string|null;
  holding:'single'|'multiple'|'unknown'; holdingBand:Band;
  lot:'single'|'multiple'|'unknown'; lotBand:Band; lotId:string|null;
  amount:number|null; quantity:number|null; kindCount:number; lotCount:number;
  unknown:UnknownCounts;
}
export interface AnalysisMetadata {
  version:1; generation:string; asOf:string; timezone:'Asia/Tokyo'; scopeId:string;
  amountBasis:string; metadataVersions:Record<string,number>; metadataEpoch?:number;
  coverageStart:string; coverageEnd:string; accuracy:'captured-current-source';
  sourceRecordCount:number; unlocatedAcquisitionRecords:number; unlocatedSalesRecords?:number;
}
export interface AnalysisBuild {
  metadata:AnalysisMetadata; inventoryValue:InventoryValue;
  categories:ProductCategory[];
  inventory:Fact[]; sales:Fact[]; acquisitions:Fact[]; retailReference:Fact[];
  referenceExclusions:{unknownChannel:number; unknownCost:number; unverifiedOrigin:number; excluded:number; salesAmount:number};
}
export interface Period { start:string; end:string; cutoff:string; timezone:'Asia/Tokyo'; partial:boolean }
export interface AnalysisRequest { target:Target; start?:string; end?:string; generation?:string; daily?:string; rollingDays?:30 }
export interface AnalysisResponse {
  status:'ok'; metadata:AnalysisMetadata; target:Target; period:Period|null;
  summary:Summary; inventoryValue:InventoryValue; referenceExclusions:AnalysisBuild['referenceExclusions'];
}
export type AnalysisResult = AnalysisResponse | {status:'missing'|'error'|'expired'};
export interface DrilldownRequest extends AnalysisRequest {
  generation:string; dimension?:Dimension; key?:string; groupKindId?:string;
  cursor?:string; limit?:number;
}
export type DetailRecord = Fact & { categoryLabel: string };
export type DetailItem =
  | { type: 'record'; record: DetailRecord }
  | { type: 'group'; group: { kindId: string; representative: DetailRecord; count: number; amount: number | null; quantity: number | null } };
export type DetailResult =
  | { status: 'ok'; items: DetailItem[]; nextCursor?: string | null }
  | { status: 'missing' | 'error' | 'expired' };



