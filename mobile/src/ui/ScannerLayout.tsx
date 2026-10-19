import React, { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";

/** Shared visual guide for native and Safari. Decoding still supports the entire camera image. */
export function ScannerLayout({ children, error, onClose, permissionAction }: {
  children?: React.ReactNode;
  error?: string;
  onClose: () => void;
  permissionAction?: () => void;
}) {
  const [size, setSize] = useState({ width: 390, height: 500 });
  const frameWidth = Math.max(0, Math.min(380, size.width * .82, Math.max(0, size.height - 24) * 1.8));
  return <Modal animationType="slide" onRequestClose={onClose}>
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="読み取りを閉じる" onPress={onClose} style={s.close}><Ionicons name="close" size={25} color="white" /></Pressable>
        <Text style={s.title}>バーコードを読み取る</Text><View style={s.headerSpacer} />
      </View>
      <View style={s.camera} onLayout={event => setSize(event.nativeEvent.layout)}>
        {children}
        <View pointerEvents="none" style={StyleSheet.absoluteFill} accessibilityRole="image" accessibilityLabel="コード全体を合わせる横長の読み取り枠">
          <View style={s.maskFill} />
          <View style={[s.frameRow, { height: frameWidth / 1.8 }]}>
            <View style={s.maskSide} />
            <View style={[s.frame, { width: frameWidth }]}>
              <View style={[s.corner, s.topLeft]} /><View style={[s.corner, s.topRight]} />
              <View style={[s.corner, s.bottomLeft]} /><View style={[s.corner, s.bottomRight]} />
              <View style={s.guideLine} />
            </View>
            <View style={s.maskSide} />
          </View>
          <View style={s.maskFill} />
        </View>
        {!!error && <View style={s.cameraMessage}><Ionicons name="camera-outline" size={38} color="#A9BFB7" /><Text accessibilityRole="alert" style={s.error}>{error}</Text></View>}
        {!!permissionAction && <View style={s.cameraMessage}><Ionicons name="camera-outline" size={38} color="#A9BFB7" /><Text style={s.error}>コードを読み取るためにカメラを使用します。</Text><Pressable accessibilityRole="button" onPress={permissionAction} style={s.allow}><Text style={s.allowText}>カメラを許可する</Text></Pressable></View>}
      </View>
      <View style={s.footer}>
        <View style={s.codeKinds}><Ionicons name="barcode-outline" size={28} color="#A9DAC9" /><Text style={s.codeKindText}>バーコード専用</Text></View>
        <Text style={s.instruction}>枠の中にバーコード全体を合わせてください</Text>
        <Text style={s.hint}>バーコードは横向きに。ピントが合うまで{`\n`}ゆっくり距離を調整してください。</Text>
      </View>
    </SafeAreaView>
  </Modal>;
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#142421" }, header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 14 }, close: { width: 44, height: 44, borderRadius: 22, backgroundColor: "#30423E", alignItems: "center", justifyContent: "center" }, title: { fontSize: 18, fontWeight: "600", color: "white" }, headerSpacer: { width: 44 },
  camera: { flex: 1, minHeight: 0, backgroundColor: "#0A1513", overflow: "hidden" }, maskFill: { flex: 1, backgroundColor: "rgba(5,18,15,.58)" }, frameRow: { flexDirection: "row" }, maskSide: { flex: 1, backgroundColor: "rgba(5,18,15,.58)" }, frame: { height: "100%", borderWidth: 1, borderColor: "#FFFFFF44" },
  corner: { position: "absolute", width: 30, height: 30, borderColor: "#B4F1D9" }, topLeft: { left: -2, top: -2, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 12 }, topRight: { right: -2, top: -2, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 12 }, bottomLeft: { left: -2, bottom: -2, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 12 }, bottomRight: { right: -2, bottom: -2, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 12 }, guideLine: { position: "absolute", top: "50%", left: 15, right: 15, height: 1, backgroundColor: "#B4F1D955" },
  cameraMessage: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "#142421F5", alignItems: "center", justifyContent: "center", padding: 25, gap: 18 }, error: { color: "white", fontSize: 15, lineHeight: 24, textAlign: "center", maxWidth: 340 }, allow: { paddingHorizontal: 22, paddingVertical: 15, borderRadius: 14, backgroundColor: "#B4F1D9" }, allowText: { color: "#183E30", fontSize: 16, fontWeight: "600" },
  footer: { alignItems: "center", paddingHorizontal: 14, paddingTop: 23, paddingBottom: 26 }, codeKinds: { flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 14 }, codeKindText: { color: "#A9DAC9", fontSize: 12 }, dot: { width: 3, height: 3, borderRadius: 2, backgroundColor: "#78978B", marginHorizontal: 10 }, instruction: { color: "white", fontSize: 15, fontWeight: "600", textAlign: "center" }, hint: { color: "#AEC0B8", fontSize: 12, lineHeight: 20, textAlign: "center", marginTop: 9 },
});
