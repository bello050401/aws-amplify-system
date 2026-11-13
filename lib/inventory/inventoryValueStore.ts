import 'server-only';
import { inventoryAuthMode, serverDataClient } from '@/lib/amplify/dataClient';
import { parseInventoryValue, type InventoryValueView } from './inventoryValue';
import {monthEndBoundary,lastClosedInventoryMonth} from './inventoryValueCalendar';

/** A single authenticated aggregate read. No scan or live fallback on dashboard load. */
export async function loadInventoryValue(month?:string): Promise<InventoryValueView> {
  try {
    if(month){monthEndBoundary(month);if(month>lastClosedInventoryMonth())return {status:'missing'};}
    const {data,errors}=await serverDataClient.models.SalesAggregateSnapshot.get(
      {id:month?`inventory:${month}:v2`:'current'}, {...inventoryAuthMode,selectionSet:['inventoryValueJson']},
    );
    if(errors?.length) return {status:'error'};
    if(!data?.inventoryValueJson) return {status:'missing'};
    const value=parseInventoryValue(data.inventoryValueJson);
    if(month&&value.month!==month)return {status:'error'};
    return {status:'ok',value};
  } catch {return {status:'error'};}
}
