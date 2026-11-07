export const EXTRACTION_VERSION = 'supplier-dimensions-2026-11-07.2';
export type Provider = 'RESTAGE' | 'YAHOO';
export type ExtractionState = 'QUEUED' | 'PROCESSING' | 'APPLIED' | 'PARTIAL' | 'REVIEW' | 'NO_DIMENSIONS' | 'NO_SOURCE' | 'FAILED' | 'EXCLUDED';
export interface SourceIdentity { provider: Provider; account: string; externalId: string; date?: string; lotNumber?: string; row: string; inventoryId: string }
export interface Region { x: number; y: number; width: number; height: number }
export interface EvidenceBlock {
  id: string; text: string; heading?: string; cells?: string[]; table?: string; row?: number;
  page?: number; imageId?: string; region?: Region; verified?: boolean;
  kind?: 'dimensions' | 'remarks' | 'condition' | 'other';
}
export interface SourceDocument {
  identity: SourceIdentity; hash: string; acquiredAt: string; url: string; format: string;
  complete: boolean; targetVerified: boolean; blocks: EvidenceBlock[]; issues: string[];
  unitPolicy?: string;
  /** Exact description HTML, preserved as evidence and never rendered as HTML. */
  originalDescriptionHtml?: string;
}
export type Axis = 'width' | 'depth' | 'height' | 'overallLength' | 'diameter' | 'seatHeight' | 'armHeight' | 'seatWidth' | 'seatDepth' | 'thickness' | 'innerWidth' | 'innerDepth' | 'innerHeight' | 'legGap';
export interface DimensionCandidate {
  id: string; axis: Axis; part: string; raw: string; unit: string | null; value: number | null;
  mm: number | null; condition: string; blockId: string; start: number; end: number;
  disposition: 'ACCEPT' | 'REVIEW' | 'EXCLUDE'; reason?: string;
}
export interface DefectCandidate { id: string; text: string; blockId: string; disposition: 'ACCEPT' | 'REVIEW'; reason?: string }
/** The complete supplier remarks, including complex sizes. Never a summary.
 * A partially legible block remains REVIEW, with the legible text and source visible. */
export interface VerbatimRemark { blockId: string; text: string; disposition: 'ACCEPT' | 'REVIEW'; reason?: string }
export interface ExtractionResult {
  version: string; source: SourceDocument; state: ExtractionState; dimensions: DimensionCandidate[];
  defects: DefectCandidate[]; remarks?: VerbatimRemark[]; issues: string[];
}
export const AXIS_LABELS: Record<Axis,string> = {width:'幅',depth:'奥行',height:'高さ',overallLength:'全長',diameter:'直径',seatHeight:'座面高',armHeight:'肘高',seatWidth:'座面幅',seatDepth:'座面奥行',thickness:'厚み',innerWidth:'内幅',innerDepth:'内奥行',innerHeight:'内高さ',legGap:'脚間'};
export const FIELD_MAP = {
  width: { label: '幅（cm）', unit: 'cm', type: 'string' },
  depth: { label: '奥行（cm）', unit: 'cm', type: 'string' },
  height: { label: '高さ（cm）', unit: 'cm', type: 'string' },
  overallLength: { label: '全長（cm）', unit: 'cm', type: 'string' },
} as const;
export const STATE_LABELS: Record<ExtractionState,string> = {QUEUED:'処理待ち',PROCESSING:'資料を確認中',APPLIED:'反映済み',PARTIAL:'一部反映・要確認',REVIEW:'要確認',NO_DIMENSIONS:'寸法記載なし',NO_SOURCE:'資料なし',FAILED:'取得・処理失敗',EXCLUDED:'除外済み'};
