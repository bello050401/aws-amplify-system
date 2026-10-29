import React from 'react';
import {View,Text,Button} from 'react-native';
export function PriceEntry({onClose}:{onClose:()=>void}){return <View><Text>販売予定価格入力はiPhone用Webアプリから利用できます。</Text><Button title="戻る" onPress={onClose}/></View>;}
