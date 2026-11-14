import {
  readInventoryAnalysis,readInventoryAnalysisDetail,readInventoryAnalysisMetadata,saveInventoryAnalysisMetadata,listInventoryAnalysisMetadata,
} from '@/app/actions/inventoryAnalysis';
import type {InventoryValueView} from '@/lib/inventory/inventoryValue';
import {InventoryValueReport} from '../InventoryValuePanel';
import {SalesAnalysis} from './SalesAnalysis';

export function ProductionSalesAnalysis({canManage,inventory,today,salesGeneration,syncLegacyMonths=false}:{
  canManage:boolean; today:string; inventory?:InventoryValueView; salesGeneration?:string|null; syncLegacyMonths?:boolean;
}) {
  return <SalesAnalysis
    ports={{load:readInventoryAnalysis,drill:readInventoryAnalysisDetail}}
    management={canManage ? {read:readInventoryAnalysisMetadata,list:listInventoryAnalysisMetadata,save:saveInventoryAnalysisMetadata} : undefined}
    today={today} salesGeneration={salesGeneration} productLinks syncLegacyMonths={syncLegacyMonths}
    inventoryFallback={inventory ? <InventoryValueReport view={inventory}/> : undefined}
  />;
}
