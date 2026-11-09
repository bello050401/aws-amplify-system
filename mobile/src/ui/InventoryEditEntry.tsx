import React from 'react';
import {View,Text,Button} from 'react-native';
export function InventoryEditEntry({onClose}:{onClose:()=>void}){return <View><Text>一括編集はBELLOのスマートフォン用Webアプリから利用できます。</Text><Button title="在庫一覧へ戻る" onPress={onClose}/></View>;}
