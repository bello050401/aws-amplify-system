import type {SaleCandidate} from './model';

export const isNotificationSale=(c:Pick<SaleCandidate,'source'>)=>c.source==='GMAIL'||c.source==='BASE_API';

/** Also pick up a human-confirmed notification when confirmation happened between worker polls. */
export function shouldSeedAutomation(c:SaleCandidate,enabledAt:string):boolean {
 if(!isNotificationSale(c))return false;
 if(c.state==='PENDING')return true;
 return c.state==='DONE'&&!!c.result&&Number.isFinite(Date.parse(enabledAt))&&
  Number.isFinite(Date.parse(c.completedAt??''))&&Date.parse(c.completedAt!)>=Date.parse(enabledAt);
}
