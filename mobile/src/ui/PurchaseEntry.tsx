import React from 'react';
import {Text,View,Button} from 'react-native';
export function PurchaseEntry({onClose}:{onClose:()=>void;onOpen:(id:string)=>void}){return <View><Text>売却管理はWebアプリからご利用ください。</Text><Button title="戻る" onPress={onClose}/></View>;}
