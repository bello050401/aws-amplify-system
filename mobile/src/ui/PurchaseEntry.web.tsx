import React from 'react';
import {SaleCandidates} from '../../../components/sales/SaleCandidates';
export function PurchaseEntry({onClose,onOpen}:{onClose:()=>void;onOpen:(id:string)=>void}){return <div style={{height:'100%',overflowY:'auto',background:'white'}}><SaleCandidates onClose={onClose} onOpen={onOpen}/></div>;}
