import React from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Image } from "expo-image";

interface Props {
  offline: boolean;
  creating: boolean;
  writesEnabled: boolean;
  onInventory: () => void;
  onCreate: () => void;
  onScan: () => void;
  onPriceEntry: () => void;
}

export function HomeScreen({ offline, creating, writesEnabled, onInventory, onCreate, onScan, onPriceEntry }: Props) {
  return <ScrollView style={s.screen} contentContainerStyle={s.content}>
    <View style={s.identity}>
      <Image source={require("../../assets/bello-system-icon.png")} style={s.logo} contentFit="contain" accessibilityLabel="Bello SYSTEM" />
      <View style={s.identityText}>
        <Text style={s.eyebrow}>BELLO SYSTEM</Text>
        <Text style={s.heading}>商品・在庫管理</Text>
        <View style={[s.connection, offline && s.offline]}>
          <Ionicons name={offline ? "cloud-offline-outline" : "wifi-outline"} size={14} color={offline ? "#886220" : "#36746A"} />
          <Text style={[s.connectionText, offline && { color: "#886220" }]}>{offline ? "圏外・保存済み情報を表示" : "オンライン"}</Text>
        </View>
      </View>
    </View>

    <Pressable accessibilityRole="button" accessibilityLabel="在庫一覧を開く" onPress={onInventory} style={({ pressed }) => [s.inventory, pressed && s.pressed]}>
      <View style={s.inventoryTop}>
        <View style={s.inventoryIcon}><Ionicons name="cube-outline" size={32} color="#E9CA87" /></View>
        <Ionicons name="arrow-forward" size={23} color="#E6ECE9" />
      </View>
      <Text style={s.inventoryTitle}>在庫一覧</Text>
      <Text style={s.inventoryHint}>商品名から探す</Text>
      <View style={s.inventorySearch}><Ionicons name="search-outline" size={17} color="#AFC4BE" /><Text style={s.inventorySearchText}>検索・絞り込み・並び替え</Text></View>
    </Pressable>

    <Text style={s.sectionTitle}>クイック操作</Text>
    <View style={s.actions}>
      {writesEnabled && <Pressable accessibilityRole="button" accessibilityLabel="新規登録" disabled={creating} onPress={onCreate} style={({ pressed }) => [s.action, pressed && s.pressed, creating && { opacity: .65 }]}>
        <View style={[s.actionIcon, { backgroundColor: "#FBF0D9" }]}>{creating ? <ActivityIndicator color="#A37B30" /> : <Ionicons name="add-circle-outline" size={32} color="#A37B30" />}</View>
        <Text style={s.actionTitle}>新規登録</Text><Text style={s.actionHint}>商品を追加する</Text>
        <Ionicons name="arrow-forward" size={18} color="#A5A7A0" style={s.actionArrow} />
      </Pressable>}
      <Pressable accessibilityRole="button" accessibilityLabel="スキャン検索" onPress={onScan} style={({ pressed }) => [s.action, pressed && s.pressed]}>
        <View style={[s.actionIcon, { backgroundColor: "#E5F2EF" }]}><Ionicons name="scan-outline" size={32} color="#3A8176" /></View>
        <Text style={s.actionTitle}>スキャン検索</Text><Text style={s.actionHint}>コードから探す</Text>
        <Ionicons name="arrow-forward" size={18} color="#A5A7A0" style={s.actionArrow} />
      </Pressable>
    </View>

    {writesEnabled && <Pressable accessibilityRole="button" accessibilityLabel="販売予定価格入力" disabled={offline} onPress={onPriceEntry} style={({pressed})=>[s.action,{marginTop:16,flex:0,padding:20,flexDirection:'row',alignItems:'center',gap:16},pressed&&s.pressed,offline&&{opacity:.5}]}><Ionicons name="pricetag-outline" size={28} color="#36746A"/><View style={{flex:1}}><Text style={s.actionTitle}>販売予定価格入力</Text><Text style={s.actionHint}>価格が未入力の商品をまとめて入力</Text></View><Ionicons name="chevron-forward" size={20} color="#7D827B"/></Pressable>}
  </ScrollView>;
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#F8F6F1" }, content: { padding: 20, paddingTop: 12, paddingBottom: 24, width: "100%", maxWidth: 620, alignSelf: "center" },
  identity: { flexDirection: "row", gap: 18, alignItems: "center", marginBottom: 26 }, logo: { width: 61.6, height: 61.6, borderRadius: 15 }, identityText: { flex: 1, minWidth: 0 },
  eyebrow: { fontSize: 10, letterSpacing: 1.8, fontWeight: "600", color: "#8D8778", marginBottom: 6 }, heading: { fontSize: 22, fontWeight: "700", color: "#26332F" },
  connection: { marginTop: 11, gap: 5, flexDirection: "row", alignItems: "center", alignSelf: "flex-start", flexWrap: "wrap" }, connectionText: { fontSize: 11, color: "#36746A", fontWeight: "500" }, offline: { opacity: .85 },
  inventory: { backgroundColor: "#263D3C", borderRadius: 24, padding: 24 }, inventoryTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }, inventoryIcon: { width: 54, height: 54, borderRadius: 17, alignItems: "center", justifyContent: "center", backgroundColor: "#37504D" },
  inventoryTitle: { color: "white", fontSize: 26, fontWeight: "700" }, inventoryHint: { color: "#D0DDD8", fontSize: 13, marginTop: 7 }, inventorySearch: { borderTopWidth: 1, borderColor: "#48605B", flexDirection: "row", gap: 8, alignItems: "center", paddingTop: 15, marginTop: 19 }, inventorySearchText: { color: "#C1D2CC", fontSize: 12 },
  sectionTitle: { fontSize: 13, fontWeight: "600", color: "#7A7D71", marginTop: 27, marginBottom: 12 }, actions: { flexDirection: "row", gap: 12 }, action: { flex: 1, minWidth: 0, backgroundColor: "white", borderWidth: 1, borderColor: "#E9E8E1", borderRadius: 22, padding: 14 }, actionIcon: { width: 54, height: 54, borderRadius: 17, alignItems: "center", justifyContent: "center", marginBottom: 17 }, actionTitle: { color: "#2E3832", fontSize: 16, fontWeight: "700" }, actionHint: { color: "#7D827B", fontSize: 11, marginTop: 6 }, actionArrow: { alignSelf: "flex-end", marginTop: 13 }, pressed: { opacity: .76 },
});
