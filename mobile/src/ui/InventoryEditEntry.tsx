import React from 'react';
import {View,Text,Button} from 'react-native';
import type {SelectionRequest} from '../../../lib/inventory/selectionRequest';
export function InventoryEditEntry({onClose}:{selection:SelectionRequest;hidden?:boolean;onFinished:(changed:boolean)=>void;onClose:(changed:boolean,pending:boolean)=>void}){return <View><Text>一括編集はBELLOのスマートフォン用Webアプリから利用できます。</Text><Button title="在庫一覧へ戻る" onPress={()=>onClose(false,false)}/></View>;}
