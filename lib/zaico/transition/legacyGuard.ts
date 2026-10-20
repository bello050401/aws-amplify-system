import 'server-only';
import {inventoryDdb,inventoryTable} from '../../inventory/categoryPersistence';
import {CONTROL_ID,transitionStore} from './store';
/** All former read entry points honor the same off switch as the new worker. */
export async function assertLegacyZaicoAllowed(){
  const control=await transitionStore(inventoryDdb,inventoryTable('ZaicoTransitionRecord')).get(CONTROL_ID);
  if(control&&control.phase!=='DISABLED')throw Error('ZAICO連携は暫定同期の設定で管理しています。従来の手動同期は停止しています。');
}
