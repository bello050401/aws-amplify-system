import React from 'react';
import {TextInput} from 'react-native';
export function InventoryQueryInput({value,onChange,onSubmit}:{value:string;onChange:(v:string)=>void;onSubmit:()=>void}){
 return <TextInput accessibilityLabel="商品名を検索" placeholder="商品名" value={value} onChangeText={onChange} onSubmitEditing={onSubmit} returnKeyType="search" style={{flex:1,fontSize:16,paddingVertical:11,minWidth:0,color:'#263936'}}/>;
}
