/** Resolve defaults from the current masters; never create a new option implicitly. */
export function newInventoryDefaults<C extends {name:string},L extends {name:string}>(categories:readonly C[],locations:readonly L[]) {
 return {category:categories.find(c=>c.name==='補修待ち'),location:locations.find(l=>l.name==='所沢事務所')};
}
