import {inventoryDdb} from '../../../lib/inventory/categoryPersistence';
import {createCandidateStore} from '../../../lib/saleCandidates/storeCore';
export function candidateConfig(){if(!process.env.SALE_CANDIDATES_TABLE)throw Error('SALE_CONFIG_MISSING');return {tableName:process.env.SALE_CANDIDATES_TABLE,functionName:''};}
export function candidateStore(){return createCandidateStore(inventoryDdb,candidateConfig().tableName);}
