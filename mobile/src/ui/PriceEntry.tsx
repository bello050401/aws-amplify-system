import React from 'react';
import {View,Text,Button} from 'react-native';
import type {PriceHistoryPorts} from '../domain/priceHistory';
export function PriceEntry({onClose}:{onClose:()=>void;historyPorts?:PriceHistoryPorts}){return <View><Text>販売予定価格入力はiPhone用Webアプリから利用できます。</Text><Button title="戻る" onPress={onClose}/></View>;}
