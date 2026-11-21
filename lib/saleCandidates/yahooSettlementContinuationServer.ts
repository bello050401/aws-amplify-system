import 'server-only';
import {candidateStore} from '@/lib/saleCandidates/store';
import {getInventoryRaw} from '../inventory/categoryPersistence';
import {canContinueAfterYahooPayment} from './yahooSettlementContinuation';
export async function settledYahooContinuation(candidateId:string,sourceId:string,oldVersion:string,remaining:number){
 const c=await candidateStore().get(candidateId);if(!c?.result||c.result.sourceId!==sourceId)return false;
 const [source,sold]=await Promise.all([getInventoryRaw(sourceId),getInventoryRaw(c.result.soldId)]);
 return canContinueAfterYahooPayment(c,source,sold,oldVersion,remaining);
}
