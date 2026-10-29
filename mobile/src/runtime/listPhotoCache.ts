import type {InventoryThumbnail} from '../domain/inventory';
import type {ListPhotoCache} from '../domain/listPhotoCache';
// Native apps retain their existing image handling. This bounded store is for Web only.
export function createListPhotoCache(_owner:string,_load:(ids:string[])=>Promise<InventoryThumbnail[]>):ListPhotoCache|undefined{return undefined;}
