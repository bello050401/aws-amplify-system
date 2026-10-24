import React from 'react';
import {DocumentForm} from '../../../components/invoicing/DocumentForm';
export function DocumentEntry({kind,onClose}:{kind:'invoice'|'receipt';onClose:()=>void}){return <div style={{height:'100%',overflowY:'auto',background:'white'}}><DocumentForm kind={kind} onClose={onClose} embedded/></div>;}
