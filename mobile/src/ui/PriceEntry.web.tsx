import React from 'react';
import {PriceEntryScreen} from '../../../components/inventory/PriceEntryScreen';
export function PriceEntry({onClose}:{onClose:()=>void}){return <PriceEntryScreen embedded onClose={onClose}/>;}
