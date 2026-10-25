import 'server-only';
import {inventoryDdb} from '@/lib/inventory/categoryPersistence';
import {getAccessToken} from '@/lib/base/oauth';
import {candidateConfig} from './store';
import {importBaseOrdersCore} from './baseImportCore';
export const importBaseOrders=()=>importBaseOrdersCore(inventoryDdb,candidateConfig().tableName,getAccessToken);
