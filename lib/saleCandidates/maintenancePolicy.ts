import type {SaleCandidate} from './model';
export type ListingObservation={inventoryId:string;selling:boolean;at:string;inventoryVersion:string};
export function shouldRetireCandidate(candidate:SaleCandidate,previous:ListingObservation|undefined,current:ListingObservation){
 // DONE includes unpaid Yahoo orders and must remain available for payment
 // reconciliation. A name match or a first observation never proves a transition.
 return candidate.state==='PENDING'&&!!previous&&previous.inventoryId===current.inventoryId&&
  previous.selling&&!current.selling&&Date.parse(previous.at)<Date.parse(current.at)&&
  previous.inventoryVersion!==current.inventoryVersion;
}
