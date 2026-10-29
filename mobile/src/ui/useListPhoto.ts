import type {ListPhotoCache} from '../domain/listPhotoCache';
import type {InventoryItem} from '../domain/inventory';
export function useListPhoto(_cache:ListPhotoCache|undefined,item:InventoryItem){return item.thumbnailUrl;}
