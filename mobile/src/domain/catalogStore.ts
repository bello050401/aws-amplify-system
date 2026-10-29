import type {KeyValueStore} from './snapshot';
import {CATALOG_MAX_BYTES,compactCatalogItem,validateCatalogState,type CatalogState} from './catalogProtocol';

/** One bounded asynchronous record per account/environment; failures leave server search available. */
export class CatalogStore {
 private key:string;
 private active=true;
 private operations:Promise<unknown>=Promise.resolve();
 constructor(private storage:KeyValueStore,private owner:string,environment:string){
  if(!owner||!environment)throw Error('ACCOUNT_REQUIRED');
  this.key=`bello.search.v2.${encodeURIComponent(environment)}.${encodeURIComponent(owner)}`;
 }
 async read():Promise<CatalogState|null>{
  if(!this.active)return null;
  const raw=await this.storage.getItem(this.key);
  if(!raw||!this.active)return null;
  try{
   if(raw.length>CATALOG_MAX_BYTES)throw Error('LIMIT');
   const value=JSON.parse(raw);
   if(value.owner!==this.owner||!validateCatalogState(value.state))throw Error('INVALID');
   return {...value.state,items:value.state.items.map(compactCatalogItem)};
  }catch{await this.storage.removeItem(this.key);return null;}
 }
 async write(state:CatalogState){
  if(!this.active)return;
  const raw=JSON.stringify({owner:this.owner,state:{...state,items:state.items.map(compactCatalogItem)}});
  if(new TextEncoder().encode(raw).byteLength>CATALOG_MAX_BYTES)throw Error('CATALOG_LIMIT');
  const operation=this.operations.then(async()=>{if(this.active)await this.storage.setItem(this.key,raw);});
  this.operations=operation.catch(()=>{});await operation;
 }
 async clearOnLogout(){this.active=false;await this.operations;await this.storage.removeItem(this.key);}
}
