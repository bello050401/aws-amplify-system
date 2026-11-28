export type WholesaleRow = {
  id: string; name: string; displayId: string; imageUrl: string | null;
  updatedAt: string; purchaseAmount: number | null; shipping: number | null;
  totalCost: number | null; sellingDays: number | null; quantity: number | null;
  saleStartDate: string | null; alreadyWholesale: boolean;
};
export type WholesaleData = {
  items: WholesaleRow[]; checkedAt: string | null; snapshotVersion: string | null;
  canEdit: boolean; unlinkedCount: number; ambiguousCount: number; warnings: string[];
};
export type WholesaleSaveRequest = {
  mutationId: string; snapshotVersion: string;
  items: {id: string; expectedUpdatedAt: string}[];
};
export type WholesaleSaveResult = {
  results: {id: string; status: 'saved' | 'already' | 'failed' | 'unknown'; message?: string}[];
};
export type WholesaleSort = 'purchaseAmount' | 'shipping' | 'totalCost' | 'sellingDays' | 'quantity';
export function sortWholesaleRows(rows: readonly WholesaleRow[], key: WholesaleSort, direction: 'asc'|'desc') {
  return [...rows].sort((a,b)=>{
    const x=a[key],y=b[key];
    if(x===null||y===null)return x===y?a.id.localeCompare(b.id):x===null?1:-1;
    return (x-y)*(direction==='asc'?1:-1)||a.id.localeCompare(b.id);
  });
}
