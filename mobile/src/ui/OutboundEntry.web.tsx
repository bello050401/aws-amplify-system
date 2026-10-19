import React from 'react';
import {OutboundScreen} from '../../../app/inventory/(protected)/outbound/OutboundScreen';

/** Render the shared screen in the app; a second document navigation could stall. */
export function OutboundEntry({offline}:{offline:boolean}){
 if(offline)return <div role="alert" style={{padding:24}}>【圏外です】通信できる状態で出庫を開いてください。</div>;
 return <div id="bello-outbound"><OutboundScreen embedded/></div>;
}
