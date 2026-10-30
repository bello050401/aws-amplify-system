import React from 'react';
import {PriceEntryScreen} from '../../../components/inventory/PriceEntryScreen';
import type {PriceHistoryPorts} from '../domain/priceHistory';
export function PriceEntry({onClose,historyPorts}:{onClose:()=>void;historyPorts?:PriceHistoryPorts}){return <PriceEntryScreen embedded onClose={onClose} historyPorts={historyPorts}/>;}
