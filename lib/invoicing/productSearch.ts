import {inventoryCategoryIds, type CategoryRecord} from '../inventory/categories';

// 「販売中」は既存カテゴリマスタでの出品中の呼称。IDはマスタから解決する。
const GROUPS = [
 {label:'出品中',names:['販売中','出品中']},
 {label:'補修待ち',names:['補修待ち']},
 {label:'撮影待ち',names:['撮影待ち']},
 {label:'出品待ち',names:['出品待ち']},
] as const;
export function invoiceProductScope(masters:readonly {id:string;name:string}[]) {
 const priority=GROUPS.map(group=>masters.filter(m=>(group.names as readonly string[]).includes(m.name)).map(m=>m.id));
 return {
  priority,
  categoryIds:[...new Set(priority.flat())],
  label(row:CategoryRecord){const ids=inventoryCategoryIds(row);const rank=priority.findIndex(group=>group.some(id=>ids.includes(id)));return rank<0?null:GROUPS[rank].label;},
 };
}
