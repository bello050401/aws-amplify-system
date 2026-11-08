import React from 'react';
import {Text,View,Pressable} from 'react-native';
export function MessageEntry({onClose}:{onClose:()=>void}){return <View><Text>メッセージはiPhone用Webアプリでご利用ください。</Text><Pressable onPress={onClose}><Text>戻る</Text></Pressable></View>;}
