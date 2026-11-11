'use server';
import {inventoryMutationSession} from '@/lib/inventory/mutationSession';
import {inventoryDdb,inventoryTable} from '@/lib/inventory/categoryPersistence';
import {createQuantityTransfer,type TransferRequest} from '@/lib/inventory/quantityTransfer';
import {listInventorySimpleSearch,listLocations} from '@/lib/inventory/queries';
import {revalidatePath} from 'next/cache';
import {clearInventoryCountCache} from '@/lib/inventory/inventoryPage';
export async function findTransferTargets(query:string){if(!await inventoryMutationSession())throw Error('編集権限がありません。');if(typeof query!=='string'||!query.trim()||query.length>500)throw Error('商品名・管理番号を入力してください。');const [result,locations]=await Promise.all([listInventorySimpleSearch({q:query.trim()},{offset:0,limit:30}),listLocations()]);return {total:result.total,items:result.items.map(i=>({id:i.id,name:i.name,sku:i.sku,quantity:i.quantity,unit:i.unit,updatedAt:i.updatedAt,location:locations.find(l=>l.id===i.locationId)?.name??'未設定',image:i.mainImageThumbnailKey??i.mainImageStorageKey}))};}
export async function transferInventoryQuantity(request:TransferRequest){const s=await inventoryMutationSession();if(!s)throw Error('編集権限がありません。');const result=await createQuantityTransfer({db:inventoryDdb,table:inventoryTable})(request,s.owner);clearInventoryCountCache();revalidatePath('/inventory');revalidatePath('/inventory/'+request.sourceId);revalidatePath('/inventory/'+request.targetId);return result;}
