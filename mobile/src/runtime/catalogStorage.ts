import type {KeyValueStore} from '../domain/snapshot';

// Native remains memory-only here. This change targets the installed/mobile Web app.
const memory=new Map<string,string>();
export const catalogStorage:KeyValueStore={getItem:async k=>memory.get(k)??null,setItem:async(k,v)=>{memory.set(k,v);},removeItem:async k=>{memory.delete(k);}};
