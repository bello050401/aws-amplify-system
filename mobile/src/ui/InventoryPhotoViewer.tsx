import React from 'react';
import {ActivityIndicator, Modal, Pressable, StyleSheet, Text, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import type {InventoryPhoto} from '../domain/inventory';
import {ZoomablePhoto} from './ZoomablePhoto';

/** Shared, read-only viewer. Mount only while open, so original images are fetched on demand. */
export function InventoryPhotoViewer({photos,index,onIndexChange,onClose,title,loading=false,notice,onRetry}: {
  photos: InventoryPhoto[]; index:number; onIndexChange:(index:number)=>void; onClose:()=>void;
  title?:string; loading?:boolean; notice?:string; onRetry?:()=>void;
}) {
  const selected=photos[index],uri=selected?.fullUrl??selected?.url;
  return <Modal visible animationType="fade" onRequestClose={onClose}>
    <SafeAreaView style={s.viewer} accessibilityViewIsModal>
      <View style={s.bar}><Text style={s.text}>{photos.length ? `${index+1} / ${photos.length}` : '写真'}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="画像を閉じる" onPress={onClose} style={s.button}><Text style={s.text}>閉じる</Text></Pressable></View>
      {!!title&&<Text numberOfLines={2} style={s.title}>{title}</Text>}
      {loading&&<View style={s.status}><ActivityIndicator color="white"/><Text style={s.hint}>写真を読み込み中…</Text></View>}
      {!!notice&&<View style={s.status}><Text accessibilityRole="alert" style={s.notice}>{notice}</Text>{onRetry&&<Pressable accessibilityRole="button" onPress={onRetry} style={s.button}><Text style={s.text}>写真を再取得</Text></Pressable>}</View>}
      {uri ? <ZoomablePhoto key={selected.id} uri={uri} onDismiss={onClose}
        onPrevious={index>0?()=>onIndexChange(index-1):undefined}
        onNext={index<photos.length-1?()=>onIndexChange(index+1):undefined}/>
        : <View style={s.empty}><Text style={s.text}>{loading?'':'表示できる写真がありません。'}</Text></View>}
      <Text style={s.hint}>下にスワイプで閉じる · ピンチ・ダブルタップで拡大</Text>
      {photos.length>1&&<View style={s.bar}>
        <Pressable accessibilityRole="button" accessibilityLabel="前の画像" disabled={index<=0} onPress={()=>onIndexChange(index-1)} style={[s.button,index<=0&&s.disabled]}><Text style={s.text}>前へ</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="次の画像" disabled={index>=photos.length-1} onPress={()=>onIndexChange(index+1)} style={[s.button,index>=photos.length-1&&s.disabled]}><Text style={s.text}>次へ</Text></Pressable>
      </View>}
    </SafeAreaView>
  </Modal>;
}
const s=StyleSheet.create({
  viewer:{flex:1,backgroundColor:'#141414'},bar:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingHorizontal:16},
  button:{minHeight:48,minWidth:64,padding:14,alignItems:'center',justifyContent:'center'},text:{color:'white',fontSize:16},
  title:{color:'#E4E4E4',fontSize:13,lineHeight:19,paddingHorizontal:16,paddingBottom:8},
  status:{flexDirection:'row',alignItems:'center',justifyContent:'center',gap:8,paddingHorizontal:16},
  notice:{color:'#FFDB96',fontSize:13,lineHeight:19,flex:1},hint:{color:'#BDBDBD',fontSize:12,textAlign:'center',padding:10},
  empty:{flex:1,justifyContent:'center',alignItems:'center'},disabled:{opacity:.3},
});
