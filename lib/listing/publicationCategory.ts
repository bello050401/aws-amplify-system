import 'server-only';
import {getInventoryRaw,persistInventoryWithCategories} from '@/lib/inventory/categoryPersistence';
import {inventoryCategoryIds} from '@/lib/inventory/categories';
import {listCategories} from '@/lib/inventory/queries';
import {clearInventoryCountCache} from '@/lib/inventory/inventoryPage';
import {withHumanEdits} from '@/lib/inventory/humanEdits';
import {parseCustomFields,stringifyCustomFields} from '@/lib/inventory/customFieldsCodec';
/** Run only after the remote channel is confirmed active. Optimistic locking preserves concurrent edits. */
export async function markInventoryPublished(id:string,actor:string){
 const [item,masters]=await Promise.all([getInventoryRaw(id),listCategories()]);if(!item)throw Error('INVENTORY_MISSING');
 const before=inventoryCategoryIds(item),pending=masters.filter(c=>['補修待ち','撮影待ち','出品待ち'].includes(c.name)).map(c=>c.id);
 if(!before.some(x=>pending.includes(x)))return;
 if(masters.some(c=>c.name==='売り切れ'&&before.includes(c.id)))throw Error('INVENTORY_ALREADY_SOLD');
 const active=masters.filter(c=>c.name==='販売中');if(active.length!==1)throw Error('ACTIVE_CATEGORY');
 const categoryIds=[...new Set([...before.filter(x=>!pending.includes(x)),active[0].id])],changes={categoryIds,categoryId:categoryIds[0]};
 const custom=parseCustomFields(item.customFields);
 await persistInventoryWithCategories({id,...changes,updatedBy:actor,listUpdatedAt:new Date().toISOString(),customFields:stringifyCustomFields(withHumanEdits(item,changes,custom,custom??undefined))},item.updatedAt);
 clearInventoryCountCache();
}
