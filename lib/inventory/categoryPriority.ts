import {inventoryCategoryIds, type CategoryRecord} from './categories';

/** Optional search order; apply before pagination, keeping the normal date order within a group. */
export function categoryPriorityComparator<T extends CategoryRecord>(groups: readonly (readonly string[])[], fallback: (a:T,b:T)=>number) {
 const rank = (row:T) => {
  const ids=inventoryCategoryIds(row);
  const index=groups.findIndex(group=>group.some(id=>ids.includes(id)));
  return index<0?groups.length:index;
 };
 return (a:T,b:T)=>rank(a)-rank(b)||fallback(a,b);
}
