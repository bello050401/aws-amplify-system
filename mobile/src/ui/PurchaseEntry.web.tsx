import React from 'react';
import {SaleCandidates} from '../../../components/sales/SaleCandidates';
export function PurchaseEntry({onClose,onOpen}:{onClose:()=>void;onOpen:(id:string)=>void}){return <div style={{flex:1,minHeight:0,width:'100%',overflowY:'auto',overscrollBehaviorY:'contain',background:'white'}}><SaleCandidates onClose={onClose} onOpen={onOpen}/></div>;}
