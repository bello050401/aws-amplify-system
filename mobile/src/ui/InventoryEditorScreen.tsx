import React, { useState, useSyncExternalStore } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { InventoryDraft, InventoryItem } from "../domain/inventory";
import { InventoryEditor } from "../domain/editor";
import { colors } from "./theme";
import { visibleDetailFields, type DetailField } from "../domain/detailFields";
import { RESTRICTED_FEATURES, type MobileFeatures } from "../domain/access";
import { InventoryPhotos } from "./InventoryPhotos";
import {DateField} from "./DateField";
import {BarcodeScanner} from "./BarcodeScanner";
import {PhotoPicker} from "./PhotoPicker";

export function InventoryEditorScreen({ editor, onLeave, onSaved, features = RESTRICTED_FEATURES }: {
  editor: InventoryEditor; onLeave: () => void; onSaved: (item: InventoryItem) => void;
  features?: MobileFeatures;
}) {
  const [scanning,setScanning]=useState(false);
  const [photoBusy,setPhotoBusy]=useState(false);
  const [master,setMaster]=useState<"category"|"location"|null>(null);
  const [choice, setChoice] = useState<DetailField | null>(null);
  const [statusChoiceOpen, setStatusChoiceOpen] = useState(false);
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  const leave = () => { if (editor.requestLeave()) onLeave(); };
  const save = async () => { const result = await editor.save(); if (result) onSaved(result); };
  const fields: { key: Exclude<keyof InventoryDraft, "details">; label: string; numeric?: boolean; multiline?: boolean }[] = [
    { key: "name", label: "物品名" }, { key: "quantity", label: "数量", numeric: true },
    { key: "unit", label: "単位" }, { key: "location", label: "保管場所" },
    { key: "category", label: "カテゴリ" }, { key: "condition", label: "状態" },
    { key: "note", label: "備考", multiline: true }, { key: "barcode", label: "QRコード・バーコードの値" },
    { key: "plannedSalePrice", label: "販売予定価格（送料別）", numeric: true },
  ];
  const extra = visibleDetailFields(features);
  return <View style={s.screen}>
    <View style={s.header}>
      <Pressable accessibilityRole="button" accessibilityLabel="一覧へ戻る" disabled={state.saving || photoBusy} onPress={leave} style={s.round}>
        <Ionicons name="close" size={30} color={colors.text} />
      </Pressable>
      <Text style={s.title}>{state.creating ? "在庫の新規登録" : "在庫の編集"}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="完了" disabled={state.saving || photoBusy} onPress={save} style={[s.done, state.saving && s.disabled]}>
        <Text style={s.white}>{state.saving ? "保存中" : "完了"}</Text>
      </Pressable>
    </View>
    {state.warning && <View accessibilityRole="alert" style={s.warning}><Text style={s.warningText}>{state.warning}</Text></View>}
    <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets contentContainerStyle={s.form}>
      {fields.map((field) => <React.Fragment key={field.key}>
        {field.key === "barcode" && <><InventoryPhotos item={state.saved} /><PhotoPicker photos={state.photos} disabled={state.saving || state.outcomeUncertain} onAdd={photos=>editor.addPhotos(photos)} onRemove={id=>editor.removePhoto(id)} onBusy={setPhotoBusy}/></>}
        <View style={s.field}>
        <Text style={s.label}>{field.label}</Text>
        {(field.key === "category" || field.key === "location") && (field.key === "category" ? state.saved.categoryOptions : state.saved.locationOptions) ? <Pressable accessibilityRole="button" accessibilityLabel={field.label} disabled={state.saving || state.outcomeUncertain} onPress={()=>setMaster(field.key as "category"|"location")} style={s.select}><Text style={s.selectText}>{state.draft[field.key] || "未設定"}</Text><Ionicons name="chevron-down" size={22} color={colors.blue}/></Pressable> : field.key === "condition" ? <Pressable accessibilityRole="button" accessibilityLabel="状態" style={s.select}
          disabled={state.saving || state.outcomeUncertain || !state.saved.statusOptions}
          onPress={() => setStatusChoiceOpen(true)}>
          <Text style={s.selectText}>{state.draft.condition || "未設定"}</Text><Ionicons name="chevron-down" size={22} color={colors.blue} />
        </Pressable> : <TextInput accessibilityLabel={field.label} style={[s.input, field.multiline && s.multiline]}
          value={state.draft[field.key]} onChangeText={(value) => editor.change(field.key, value)}
          editable={!state.saving && !state.outcomeUncertain} inputMode={field.numeric ? "numeric" : "text"} keyboardType={field.numeric ? "number-pad" : "default"}
          multiline={field.multiline} textAlignVertical={field.multiline ? "top" : "center"} />}
        {field.key === "barcode" && <Pressable accessibilityRole="button" accessibilityLabel="コードを撮影して登録" disabled={state.saving || state.outcomeUncertain} onPress={()=>setScanning(true)} style={[s.choice,{borderWidth:1,borderColor:colors.blue,marginTop:14}]}><Text style={s.link}>コードを撮影して登録</Text></Pressable>}
      </View></React.Fragment>)}
      {extra.map((field, index) => <View key={field.key}>
        {(index === 0 || field.section !== extra[index - 1].section) && <Text style={s.sectionHeading}>{field.section}</Text>}
        <View style={s.field}><Text style={s.label}>{field.label}</Text>
          {field.kind === "date" ? <DateField label={field.label} value={state.draft.details[field.key] ?? ""} disabled={state.saving || state.outcomeUncertain} onChange={value=>editor.changeDetail(field.key,value)}/> : field.options ? <Pressable accessibilityRole="button" accessibilityLabel={field.label} style={s.select} disabled={state.saving || state.outcomeUncertain} onPress={() => setChoice(field)}><Text style={s.selectText}>{state.draft.details[field.key] || "未設定"}</Text><Ionicons name="chevron-down" size={22} color={colors.blue} /></Pressable> :
            <TextInput accessibilityLabel={field.label} style={[s.input, field.kind === "multiline" && s.multiline, field.readOnly && s.readOnly]}
              value={state.draft.details[field.key] ?? ""} onChangeText={value => editor.changeDetail(field.key, value)}
              editable={!state.saving && !state.outcomeUncertain && !field.readOnly}
              inputMode={field.inputMode ?? (field.kind === "money" || field.kind === "integer" ? "numeric" : "text")} keyboardType={field.inputMode === "decimal" ? "decimal-pad" : field.inputMode === "numeric" || field.kind === "money" || field.kind === "integer" ? "number-pad" : "default"}
              multiline={field.kind === "multiline"} textAlignVertical={field.kind === "multiline" ? "top" : "center"} />}
          {field.key === "purchasePrice" && <Text style={s.hint}>自社システムでは送料などを含めた原価を入力します。</Text>}
        </View>
      </View>)}
      <Text style={s.hint}>変更は「完了」を押して保存できたときに反映されます。</Text>
    </ScrollView>
    {scanning && <BarcodeScanner onClose={()=>setScanning(false)} onRead={value=>{editor.change("barcode",value);setScanning(false);}}/>}
    <Modal visible={master!==null} transparent animationType="slide" onRequestClose={()=>setMaster(null)}><View style={s.shade}><View style={s.dialog}><Text style={s.dialogTitle}>{master==="category"?"カテゴリ":"保管場所"}</Text><ScrollView style={{maxHeight:400}}>{["",...new Set(master==="category"?state.saved.categoryOptions:state.saved.locationOptions)].map(value=><Pressable accessibilityRole="button" key={value} style={s.choice} onPress={()=>{if(master)editor.change(master,value);setMaster(null);}}><Text style={s.link}>{value||"未設定"}</Text></Pressable>)}</ScrollView><Pressable accessibilityRole="button" onPress={()=>setMaster(null)} style={s.choice}><Text style={s.link}>キャンセル</Text></Pressable></View></View></Modal>
    <Modal visible={statusChoiceOpen} transparent animationType="slide" onRequestClose={() => setStatusChoiceOpen(false)}>
      <View style={s.shade}><View style={s.dialog}><Text style={s.dialogTitle}>状態</Text>
        <ScrollView style={{ maxHeight: 360 }}>
          {[{ id: "", label: "未設定" }, ...(state.saved.statusOptions ?? [])].map(option =>
            <Pressable key={option.id} accessibilityRole="button" style={s.choice} onPress={() => { editor.chooseStatus(option.id); setStatusChoiceOpen(false); }}>
              <Text style={s.link}>{option.label}</Text>
            </Pressable>)}
        </ScrollView>
        <Pressable accessibilityRole="button" style={s.choice} onPress={() => setStatusChoiceOpen(false)}><Text style={s.link}>キャンセル</Text></Pressable>
      </View></View>
    </Modal>
    <Modal visible={choice !== null} transparent animationType="slide" onRequestClose={() => setChoice(null)}>
      <View style={s.shade}><View style={s.dialog}><Text style={s.dialogTitle}>{choice?.label}</Text>
        {["", ...new Set([...(choice?.options ?? []), ...(choice && state.draft.details[choice.key] ? [state.draft.details[choice.key]] : [])])].map(value => <Pressable key={value} accessibilityRole="button" style={s.choice} onPress={() => { if (choice) editor.changeDetail(choice.key, value); setChoice(null); }}><Text style={s.link}>{value || "未設定"}</Text></Pressable>)}
        <Pressable accessibilityRole="button" style={s.choice} onPress={() => setChoice(null)}><Text style={s.link}>キャンセル</Text></Pressable>
      </View></View>
    </Modal>
    <Modal visible={state.leaveConfirmation} transparent animationType="fade" onRequestClose={() => editor.continueEditing()}>
      <View style={s.shade}><View accessibilityViewIsModal style={s.dialog}>
        <Text style={s.dialogTitle}>変更内容をどうしますか？</Text>
        <Text style={s.dialogText}>保存してから一覧に戻るか、変更内容を破棄するかを選んでください。</Text>
        {state.warning && <Text accessibilityRole="alert" style={s.warningText}>{state.warning}</Text>}
        <Pressable accessibilityRole="button" disabled={state.saving} onPress={save} style={[s.choice, s.primary]}><Text style={s.white}>{state.saving ? "保存中…" : "変更を保存する"}</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={state.saving} onPress={() => { if (editor.discard()) onLeave(); }} style={s.choice}><Text style={s.destructive}>変更内容を破棄する</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={state.saving} onPress={() => editor.continueEditing()} style={s.choice}><Text style={s.link}>編集を続ける</Text></Pressable>
      </View></View>
    </Modal>
  </View>;
}
const s = StyleSheet.create({
  sectionHeading: { fontSize: 20, fontWeight: "700", color: colors.text, paddingVertical: 18, borderTopWidth: 1, borderColor: colors.border, marginTop: 8 },
  select: { borderWidth: 1, borderColor: "#AAAFAA", borderRadius: 10, minHeight: 54, padding: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, selectText: { fontSize: 17, color: colors.text }, readOnly: { backgroundColor: "#F4F2EE" },
  screen: { flex: 1, backgroundColor: colors.paper }, header: { backgroundColor: colors.cream, flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 18 },
  round: { width: 48, height: 48, borderRadius: 24, backgroundColor: "#FFF9ED", alignItems: "center", justifyContent: "center" }, title: { fontSize: 20, fontWeight: "700", color: colors.text },
  done: { paddingVertical: 13, paddingHorizontal: 20, backgroundColor: colors.blue, borderRadius: 26 }, white: { color: "white", fontSize: 16, fontWeight: "600", textAlign: "center" }, disabled: { opacity: .5 },
  form: { padding: 20, paddingBottom: 50 }, field: { marginBottom: 24 }, label: { fontSize: 18, fontWeight: "600", color: colors.muted, marginBottom: 10 },
  input: { borderWidth: 1, borderColor: "#AAAFAA", borderRadius: 10, minHeight: 54, padding: 14, fontSize: 17, color: colors.text, backgroundColor: colors.paper }, multiline: { height: 125 },
  warning: { padding: 12, backgroundColor: "#FFF2EB" }, warningText: { color: colors.danger, fontSize: 15, lineHeight: 23 }, hint: { fontSize: 13, color: colors.muted },
  shade: { flex: 1, backgroundColor: "#00000055", alignItems: "center", justifyContent: "center", padding: 24 }, dialog: { width: "100%", maxWidth: 400, backgroundColor: "white", borderRadius: 24, padding: 24, gap: 12 },
  dialogTitle: { fontSize: 20, fontWeight: "700", color: colors.text }, dialogText: { fontSize: 15, lineHeight: 23, color: colors.muted }, choice: { minHeight: 48, borderRadius: 12, alignItems: "center", justifyContent: "center", padding: 12 },
  primary: { backgroundColor: colors.blue }, destructive: { color: colors.danger, fontSize: 16 }, link: { color: colors.blue, fontSize: 16 },
});
