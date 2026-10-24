import React from 'react';
import {Text,View,Pressable} from 'react-native';
export function DocumentEntry({onClose}:{kind:'invoice'|'receipt';onClose:()=>void}){return <View><Text>帳票発行はiPhone用Webアプリでご利用ください。</Text><Pressable onPress={onClose}><Text>戻る</Text></Pressable></View>;}
