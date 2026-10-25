import React from 'react';
import {DocumentForm} from '../../../components/invoicing/DocumentForm';
export function DocumentEntry({onClose}:{onClose:()=>void}){return <div style={{height:'100%',overflowY:'auto',background:'white'}}><DocumentForm onClose={onClose} embedded/></div>;}
