import {inventoryMutationSession} from '@/lib/inventory/mutationSession';
import {InventorySelectionProvider} from '@/app/inventory/(protected)/InventorySelectionProvider';
import {UnsavedChangesProvider} from '@/app/inventory/UnsavedChangesProvider';
export const dynamic='force-dynamic';
export default async function Layout({children}:{children:React.ReactNode}){
 const access=await inventoryMutationSession();
 if(!access)return <p className="p-5">在庫を編集する権限を確認してください。</p>;
 return <UnsavedChangesProvider><InventorySelectionProvider editable>{children}</InventorySelectionProvider></UnsavedChangesProvider>;
}
