import {defineFunction} from '@aws-amplify/backend';
export const purchaseNotifications=defineFunction({name:'purchase-notifications',entry:'./handler.ts',resourceGroupName:'data',timeoutSeconds:180,memoryMB:256,logging:{format:'json',retention:'1 week'},schedule:'every 5m'});
