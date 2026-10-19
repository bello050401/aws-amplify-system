import React from 'react';
import {Text,View} from 'react-native';
export function OutboundEntry({offline}:{offline:boolean}){
 return <View style={{padding:24}}><Text>{offline?'【圏外です】通信できる状態で出庫を開いてください。':'出庫はiPhoneのウェブアプリから利用できます。'}</Text></View>;
}
