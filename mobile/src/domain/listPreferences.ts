import type {InventorySort} from './search';
interface Store {getItem(key:string):Promise<string|null>;setItem(key:string,value:string):Promise<void>}
/** Only presentation preferences, scoped to the authenticated account. No inventory or query text. */
export class ListPreferences {
 private key:string;
 constructor(private store:Store,owner:string,origin:string){this.key='bello:list-sort:v1:'+encodeURIComponent(origin)+':'+encodeURIComponent(owner);}
 async read():Promise<InventorySort|null>{
  try {const raw=await this.store.getItem(this.key);if(!raw||raw.length>500)return null;
   const value=JSON.parse(raw);
   return typeof value.field==='string'&&value.field.length<=120&&['asc','desc'].includes(value.direction)?{field:value.field,direction:value.direction}:null;
  }catch{return null;}
 }
 write(value:InventorySort){return this.store.setItem(this.key,JSON.stringify({field:value.field,direction:value.direction}));}
}
