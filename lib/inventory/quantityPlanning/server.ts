import 'server-only';
import { canEditInventory, getVerifiedInventoryAccess } from '@/lib/amplify/requireInventoryUser';
import { inventoryDdb, inventoryTable } from '../categoryPersistence';
import { inventoryVerifiedReadSession } from '../mutationSession';
import { createQuantityPlanningService } from './service';
import { createQuantityPlanningStore } from './store';

export function quantityPlanningServer(expectedOwner?: string) {
  return createQuantityPlanningService({
    authorize: async () => {
      const access = await getVerifiedInventoryAccess();
      if (access.kind !== 'authorized' || !access.owner || (expectedOwner !== undefined && access.owner !== expectedOwner)) return null;
      const verified = await inventoryVerifiedReadSession();
      return verified && verified.owner === access.owner && verified.role === access.role
        ? { owner: access.owner, role: access.role }
        : null;
    },
    canEdit: canEditInventory,
    store: createQuantityPlanningStore(inventoryDdb, inventoryTable),
  });
}
