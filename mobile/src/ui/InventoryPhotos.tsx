import React, { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { InventoryItem, InventoryPhoto } from "../domain/inventory";
import { colors } from "./theme";
import {InventoryPhotoViewer} from './InventoryPhotoViewer';

export function InventoryPhotos({ item, onRemove, onDeleteAsset, onRetry, disabled = false }: { item: InventoryItem; onRemove?: (id: string) => void; onDeleteAsset?: (id:string)=>Promise<void>; onRetry?: () => void; disabled?: boolean }) {
  const [deleteError,setDeleteError]=useState('');
  const [deleting,setDeleting]=useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<InventoryPhoto | null>(null);
  const [group, setGroup] = useState<"NORMAL" | "DAMAGE">("NORMAL");
  const [shown, setShown] = useState(24);
  const photos: InventoryPhoto[] = item.photos ?? (item.thumbnailUrl ? [{ id: "thumbnail", url: item.thumbnailUrl, primary: true }] : []);
  const normal = photos.filter(photo => photo.type !== "DAMAGE");
  const damage = photos.filter(photo => photo.type === "DAMAGE");
  const current = [...(group === "DAMAGE" ? damage : normal)].sort((a, b) => Number(b.primary) - Number(a.primary));
  const hero = current[0];
  const selectedIndex = current.findIndex(photo => photo.id === expanded);
  const selected = current[selectedIndex];
  const picture = (photo: InventoryPhoto, large = false) => photo.url ?
    <Image source={{ uri: photo.url, cacheKey: `${item.id}:${photo.id}:${item.updatedAt}:preview` }} style={large ? s.hero : s.photo} cachePolicy="memory-disk" contentFit={large ? "contain" : "cover"} /> :
    <View style={[large ? s.hero : s.photo, s.empty]}><Ionicons name="image-outline" size={30} color={colors.muted} /><Text style={s.caption}>取得できません</Text></View>;
  return <View style={s.section}>
    <View style={s.headingRow}><Text style={s.heading}>画像</Text><Text style={s.count}>{item.photosDeferred ? '読み込み中' : `合計 ${photos.length}枚`}</Text></View>
    {item.photosDeferred ? <Text style={s.caption}>写真を読み込んでいます。ほかの項目は編集できます。</Text> : item.photosComplete === false && <View><Text accessibilityRole="alert" style={s.warning}>画像をすべて取得できませんでした。ほかの項目は編集できます。</Text>{onRetry && <Pressable accessibilityRole="button" accessibilityLabel="画像を再読み込み" disabled={disabled} onPress={onRetry} style={s.more}><Text style={s.moreText}>画像を再読み込み</Text></Pressable>}</View>}
    <View style={s.tabs}>
      {([ ["NORMAL", "商品画像", normal.length], ["DAMAGE", "傷・状態", damage.length] ] as const).map(([value, label, count]) =>
        <Pressable key={value} accessibilityRole="tab" accessibilityLabel={`${label} ${count}枚`} accessibilityState={{ selected: group === value }} onPress={() => { setGroup(value); setShown(24); }} style={[s.tab, group === value && s.activeTab]}>
          <Text style={[s.tabText, group === value && s.activeText]}>{label} {count}枚</Text>
        </Pressable>)}
    </View>
    {hero ? <Pressable accessibilityRole="button" accessibilityLabel="選択中の画像を拡大" onPress={() => setExpanded(hero.id)} style={s.heroWrap}>
      {picture(hero, true)}{hero.primary && <Text style={s.badge}>主画像</Text>}
    </Pressable> : <View style={[s.hero, s.empty]}><Ionicons name="image-outline" size={36} color={colors.muted} /><Text style={s.caption}>{item.photosDeferred ? '画像を読み込み中' : item.photosComplete === false ? '画像を取得できませんでした' : '画像なし'}</Text></View>}
    <View style={s.grid}>
      {current.slice(0, shown).map((photo, index) => <View key={photo.id} style={[s.cell, photo.primary && s.primary]}>
        <Pressable accessibilityRole="button" accessibilityLabel={`${group === "DAMAGE" ? "傷・状態" : "商品画像"}${index + 1}を拡大`} onPress={() => setExpanded(photo.id)}>
          {picture(photo)}<Text style={s.photoLabel}>{photo.primary ? "主画像" : `${index + 1}`} {photo.source === "PHOTO_ASSET" ? "・撮影" : ""}</Text>
        </Pressable>
        {((onRemove && photo.source === "INVENTORY") || (onDeleteAsset && photo.source === "PHOTO_ASSET")) && <Pressable accessibilityRole="button" accessibilityLabel={`${group === "DAMAGE" ? "傷・状態" : "商品画像"}${index + 1}を削除`} disabled={disabled} onPress={() => {setDeleteError('');setRemoveTarget(photo);}} style={s.remove}><Text style={s.removeText}>削除</Text></Pressable>}
      </View>)}
    </View>
    {current.length > shown && <Pressable accessibilityRole="button" style={s.more} onPress={() => setShown(value => value + 24)}><Text style={s.moreText}>残り{current.length - shown}枚を表示</Text></Pressable>}

    {selected&&<InventoryPhotoViewer photos={current} index={selectedIndex} onIndexChange={index=>setExpanded(current[index].id)} onClose={()=>setExpanded(null)} title={item.name} onRetry={onRetry}/>}
    <Modal visible={removeTarget !== null} transparent animationType="fade" onRequestClose={() => {if(!deleting)setRemoveTarget(null);}}>
      <View style={s.shade}><View style={s.dialog} accessibilityViewIsModal>
        <Text style={s.heading}>この写真を削除しますか？</Text>
        <Text style={s.caption}>{removeTarget?.source==='PHOTO_ASSET'?'削除すると、この商品の写真から取り除かれます。':'「完了」で保存すると削除されます。保存前は元に戻せます。'}</Text>
        {deleteError&&<Text accessibilityRole="alert" style={s.warning}>{deleteError}</Text>}
        {removeTarget && picture(removeTarget, true)}
        <Pressable accessibilityRole="button" accessibilityLabel="写真の削除を確定" disabled={disabled||deleting} style={s.remove} onPress={async () => {if(!removeTarget||deleting)return;setDeleting(true);setDeleteError('');try{if(removeTarget.source==='PHOTO_ASSET')await onDeleteAsset?.(removeTarget.id);else onRemove?.(removeTarget.id);setRemoveTarget(null);setExpanded(null);}catch(e){setDeleteError(e instanceof Error?e.message:'写真を削除できませんでした。');}finally{setDeleting(false);}}}><Text style={s.removeText}>削除する</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="写真の削除をキャンセル" disabled={deleting} onPress={() => setRemoveTarget(null)} style={s.remove}><Text style={s.moreText}>キャンセル</Text></Pressable>
      </View></View>
    </Modal>
  </View>;
}
const s = StyleSheet.create({
  remove: { minHeight: 44, padding: 10, alignItems: "center", justifyContent: "center" }, removeText: { color: colors.danger, fontSize: 14 },
  shade: { flex: 1, backgroundColor: "#00000055", alignItems: "center", justifyContent: "center", padding: 20 }, dialog: { backgroundColor: "white", borderRadius: 18, padding: 18, gap: 10, width: "100%", maxWidth: 400 },
  section: { marginBottom: 12 }, headingRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }, heading: { fontSize: 16, lineHeight: 22, fontWeight: "600", color: colors.text }, count: { fontSize: 12, color: colors.muted },
  tabs: { flexDirection: "row", backgroundColor: "#F3F0EA", borderRadius: 12, padding: 3, marginBottom: 10 }, tab: { flex: 1, minHeight: 44, padding: 8, borderRadius: 9, alignItems: "center", justifyContent: "center" }, activeTab: { backgroundColor: "white" }, tabText: { color: colors.muted, fontSize: 13 }, activeText: { color: colors.blue, fontWeight: "700" },
  heroWrap: { position: "relative" }, hero: { width: "100%", height: 200, borderRadius: 10, backgroundColor: "#F7F5F1" }, badge: { position: "absolute", left: 8, top: 8, backgroundColor: colors.orange, color: "#352A1B", fontSize: 11, padding: 5, borderRadius: 5 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginVertical: 12 }, cell: { width: "31%", borderRadius: 10, borderWidth: 2, borderColor: "transparent", overflow: "hidden" }, photo: { width: "100%", aspectRatio: 1, borderRadius: 8 }, primary: { borderColor: colors.orange }, photoLabel: { fontSize: 11, color: colors.muted, padding: 5 },
  empty: { justifyContent: "center", alignItems: "center", gap: 6 }, caption: { fontSize: 12, color: colors.muted, lineHeight: 19 }, warning: { fontSize: 13, color: colors.danger, marginBottom: 12, lineHeight: 20 }, more: { padding: 14, borderWidth: 1, borderColor: colors.border, borderRadius: 10, alignItems: "center", marginBottom: 12 }, moreText: { color: colors.blue, fontSize: 14 },

});
