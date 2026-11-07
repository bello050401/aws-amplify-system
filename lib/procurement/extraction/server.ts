import 'server-only';
import outputs from '@/amplify_outputs.json';
import {ExtractionRepository,type ExtractionConfig} from './jobs';
export function extractionRepository(){
 const c=(outputs as unknown as {custom?:{supplierExtraction?:ExtractionConfig}}).custom?.supplierExtraction;
 if(!c?.table||!c.bucket||!c.inventoryTable||!c.historyTable)throw Error('仕入先資料の確認機能は反映準備中です。');
 return new ExtractionRepository(c);
}
