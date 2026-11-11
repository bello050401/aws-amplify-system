/** Display preferences never change stock data or selection filters. */
export const INVENTORY_VIEW_KEY = 'bello-inventory-view-v1';
export interface InventoryViewPreferences {
  pinFirstColumn: boolean;
  keepSelection: boolean;
  categoryPlacement: 'column' | 'name';
  hiddenCategories: string[];
  categoryOrder: string[];
  hiddenLocations: string[];
  locationOrder: string[];
  detailHidden: string[];
  detailOrder: string[];
}
export const defaultInventoryView = (): InventoryViewPreferences => ({pinFirstColumn:false,keepSelection:false,categoryPlacement:'column',hiddenCategories:[],categoryOrder:[],hiddenLocations:[],locationOrder:[],detailHidden:[],detailOrder:[]});
export function sanitizeInventoryView(input: unknown): InventoryViewPreferences {
  const out=defaultInventoryView();
  if(!input||typeof input!=='object'||Array.isArray(input))return out;
  const raw=input as Record<string,unknown>;
  for(const key of ['pinFirstColumn','keepSelection'] as const)if(typeof raw[key]==='boolean')out[key]=raw[key];
  if(raw.categoryPlacement==='name')out.categoryPlacement='name';
  for(const key of ['hiddenCategories','categoryOrder','hiddenLocations','locationOrder','detailHidden','detailOrder'] as const)
    if(Array.isArray(raw[key]))out[key]=[...new Set(raw[key].filter((v):v is string=>typeof v==='string'&&v.length>0&&v.length<=240))].slice(0,1000);
  return out;
}
export function orderedVisibleOptions<T extends {id:string}>(items: readonly T[], order:readonly string[], hidden:readonly string[], active:readonly string[]=[]):T[] {
  const rank=new Map(order.map((id,i)=>[id,i]));
  return items.filter(v=>!hidden.includes(v.id)||active.includes(v.id)).map((v,i)=>({v,i})).sort((a,b)=>(rank.get(a.v.id)??order.length+a.i)-(rank.get(b.v.id)??order.length+b.i)).map(x=>x.v);
}
