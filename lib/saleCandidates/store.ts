import 'server-only';
import outputs from '../../amplify_outputs.json';
import {inventoryDdb} from '../inventory/categoryPersistence';
import {createCandidateStore} from './storeCore';
export function candidateConfig(){
 const config=(outputs as unknown as {custom?:{saleCandidates?:{tableName:string;functionName:string}}}).custom?.saleCandidates;
 if(!config)throw Error('PURCHASE_NOT_CONFIGURED');return config;
}
export function candidateStore(){return createCandidateStore(inventoryDdb,process.env.SALE_CANDIDATES_TABLE||candidateConfig().tableName);}
