import {defineFunction} from '@aws-amplify/backend';
export const invoiceIssuer=defineFunction({name:'invoice-issuer',entry:'./handler.ts',resourceGroupName:'data',timeoutSeconds:90,memoryMB:512,logging:{format:'json',retention:'1 week'}});
