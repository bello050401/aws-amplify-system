/** ZAICOの実画面で確認した現行候補（2026-10-24）。マスタ自体は削除しない。 */
export const CURRENT_LOCATION_NAMES=['所沢事務所','プラスロジ三芳','イエローテイル川越','大原自宅','市川自宅'] as const;
export function selectableLocations<T extends {id:string;name:string}>(options:T[],currentId?:string|null):T[]{
 return options.filter(o=>CURRENT_LOCATION_NAMES.some(name=>name===o.name)||o.id===currentId).sort((a,b)=>{
  const rank=(name:string)=>{const n=CURRENT_LOCATION_NAMES.findIndex(v=>v===name);return n<0?99:n;};return rank(a.name)-rank(b.name);
 });
}
