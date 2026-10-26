import type {KeyValueStore} from './snapshot';
/** Approval-gated mode keeps inventory only in this tab's memory, never on disk. */
export class MemoryKeyValueStore implements KeyValueStore {
  private readonly values=new Map<string,string>();
  async getItem(key:string){return this.values.get(key)??null;}
  async setItem(key:string,value:string){this.values.set(key,value);}
  async removeItem(key:string){this.values.delete(key);}
}
