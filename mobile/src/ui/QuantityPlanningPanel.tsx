import React, { useEffect, useRef, useState, type ComponentRef, type ReactNode } from "react";
import {
  AppState, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet,
  Text, TextInput, View, type LayoutChangeEvent,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  allocation, estimatedArea, issueMessage, maintenanceChoices, missingStockIssues, planningCaveat,
  resultDetails, resultFacts, sourceFacts, stockIssue, storageMethods, units,
} from "../../../lib/inventory/quantityPlanning/presentation";
import type { QuantityPlan, StorageMethod } from "../../../lib/inventory/quantityPlanning/types";
import { useQuantityPlanning, type QuantityPlanningPorts } from "../../../lib/inventory/quantityPlanning/useQuantityPlanning";
import { colors } from "./theme";

function Action({ label, onPress, disabled = false, quiet = false }: {
  label: string; onPress: () => void; disabled?: boolean; quiet?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={disabled}
    style={[styles.button, quiet && styles.secondary, disabled && styles.disabled]}>
    <Text style={[styles.buttonText, quiet && styles.secondaryText]}>{label}</Text>
  </Pressable>;
}

function QuantityResult({ plan }: { plan: QuantityPlan }) {
  const [details, setDetails] = useState(false);
  const { retailQuantity, wholesaleQuantity, retailPercentage } = allocation(plan);
  return <View style={styles.group}>
    <View style={styles.card}>
      <View style={styles.row}>
        <View style={styles.cell}><Text style={[styles.label, styles.retailText]}>通常販売に残す</Text><Text style={[styles.allocation, styles.retailText]}>{units(retailQuantity)}</Text></View>
        <View style={styles.cell}><Text style={[styles.label, styles.wholesaleText]}>業販に回す</Text><Text style={[styles.allocation, styles.wholesaleText]}>{units(wholesaleQuantity)}</Text></View>
      </View>
      <View accessible={false} style={[styles.bar, retailQuantity + wholesaleQuantity === 0 && { backgroundColor: "#e5e7eb" }]}>
        <View style={{ backgroundColor: "#047857", width: `${retailPercentage}%` }} />
      </View>
    </View>
    {resultFacts(plan).map(([label, value]) => <View key={label} style={styles.detailFact}>
      <Text style={styles.label}>{label}</Text><Text style={styles.metric}>{value}</Text>
    </View>)}
    {plan.inputs.area.source !== "inventory" && <Text style={styles.note}>{estimatedArea}。</Text>}
    <Text style={styles.note}>{planningCaveat}</Text>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: details }} style={[styles.button, styles.secondary]} onPress={() => setDetails(value => !value)}>
      <Text style={[styles.buttonText, styles.secondaryText]}>価格・販売ペース・費用・面積の詳細</Text>
    </Pressable>
    {details && resultDetails(plan).map(([label, value], index) => <View key={index} style={styles.detailFact}>
      <Text style={styles.label}>{label}</Text><Text style={styles.body}>{value}</Text>
    </View>)}
  </View>;
}

export function NativeQuantityPlanningPanel({ id, version, ports, canWrite, enabled, newOperationId, image, onEdit, onSettings }: {
  id: string; version: string; ports: QuantityPlanningPorts; canWrite: boolean; enabled: boolean;
  newOperationId: () => string; image?: ReactNode; onEdit?: () => void; onSettings?: () => Promise<void>;
}) {
  const state = useQuantityPlanning({ id, version, ports, enabled, canWrite, newOperationId });
  const { source, snapshot, draft, busy, plan } = state;
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const scroller = useRef<ComponentRef<typeof ScrollView>>(null);
  const resultY = useRef(0);
  const scrollOnLayout = useRef(false);
  const latest = snapshot?.latest;
  const issues = source ? [...new Map([...missingStockIssues(source), ...state.issues].map(issue => [issue.field, issue])).values()] : state.issues;
  const missingStock = issues.some(stockIssue);
  const missingArea = issues.some(issue => issue.field === "area");
  const disabled = !enabled || !!busy || state.loading;

  useEffect(() => {
    if (!enabled) return;
    const subscription = AppState.addEventListener("change", status => {
      if (status === "active") void state.refresh();
    });
    return () => subscription.remove();
  }, [enabled, state.refresh]);

  function showResult(event: LayoutChangeEvent) {
    resultY.current = event.nativeEvent.layout.y;
    if (scrollOnLayout.current) {
      scrollOnLayout.current = false;
      scroller.current?.scrollTo({ y: resultY.current, animated: true });
    }
  }

  return <View style={styles.panel}>
    <Text accessibilityRole="header" style={styles.title}>適正数量</Text>
    <Action label="適正数量の計算" disabled={!enabled || !snapshot || state.loading} onPress={() => {
      setMaintenanceOpen(false);
      setSettingsError("");
      state.begin();
    }} />
    {!enabled && <Text style={styles.note}>通信できる場所で適正数量を確認できます。</Text>}
    {enabled && state.loading && !snapshot && <Text accessibilityLiveRegion="polite" style={styles.note}>適正数量の保存結果を読み込み中…</Text>}
    {enabled && state.readError && <View style={styles.group}><Text accessibilityRole="alert" style={styles.error}>{state.readError}</Text>
      <Action quiet label="読み込みを再試行" onPress={() => void state.refresh()} /></View>}
    {latest && <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.title}>保存済みの計算結果</Text>
      <Text style={styles.note}>{new Date(latest.calculatedAt).toLocaleString("ja-JP")}</Text>
      {snapshot.stale && <Text accessibilityLiveRegion="polite" style={styles.warning}>再計算が必要です。在庫または計算設定が更新されています。</Text>}
      <QuantityResult plan={latest.calculation.plan} />
    </View>}

    <Modal visible={state.open} animationType="slide" onRequestClose={state.close} presentationStyle="fullScreen">
      <SafeAreaView style={styles.screen} accessibilityViewIsModal>
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.title}>適正数量の計算</Text>
          <Action quiet label="閉じる" disabled={!!busy} onPress={state.close} />
        </View>
        {source && <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <ScrollView ref={scroller} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scroll}>
            <View style={styles.row}>
              {image}
              <View style={styles.cell}>
                <Text accessibilityRole="header" style={styles.title}>{source.title}</Text>
                <Text style={styles.note}>カテゴリ {source.categoryName ?? source.workflowCategoryName ?? "未登録"}</Text>
                <Text style={styles.note}>ブランド {source.brand ?? "未登録"}</Text>
              </View>
            </View>
            <View style={styles.factGrid}>{sourceFacts(source).map(([label, value]) => <View key={label} style={styles.sourceFact}>
              <Text style={styles.label}>{label}</Text><Text style={styles.metric}>{value}</Text>
            </View>)}</View>

            <View style={styles.group}>
              <Text accessibilityRole="header" style={styles.title}>計算条件</Text>
              <Text style={styles.label}>販売ペース</Text>
              <View style={styles.row}>
                <View style={styles.cell}>
                  <Text style={styles.label}>販売期間（ヶ月）</Text>
                  <TextInput accessibilityLabel="販売期間（ヶ月）" keyboardType="decimal-pad" inputMode="decimal" editable={!disabled}
                    value={draft.saleMonths} onChangeText={saleMonths => state.change({ saleMonths })} style={styles.input} />
                </View>
                <View style={styles.cell}>
                  <Text style={styles.label}>販売見込み（個）</Text>
                  <TextInput accessibilityLabel="販売見込み（個）" keyboardType="number-pad" inputMode="numeric" editable={!disabled}
                    value={draft.saleCount} onChangeText={saleCount => state.change({ saleCount })} style={styles.input} />
                </View>
              </View>
              <Text style={styles.note}>まとめ買いも含め、期間内に合計何個売れるかを入力してください。</Text>
            </View>

            <View style={styles.group}>
              <Text style={styles.label}>残りのメンテナンス時間（1個あたり）</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={`残りのメンテナンス時間 ${draft.maintenanceMinutes === null ? "選択してください" : `${draft.maintenanceMinutes}分`}`}
                accessibilityState={{ expanded: maintenanceOpen, disabled }} disabled={disabled}
                onPress={() => setMaintenanceOpen(value => !value)} style={[styles.button, styles.secondary]}>
                <Text style={[styles.buttonText, styles.secondaryText]}>{draft.maintenanceMinutes === null ? "選択してください" : `${draft.maintenanceMinutes}分`}</Text>
              </Pressable>
              {maintenanceOpen && <View style={styles.choices}>
                {maintenanceChoices.map(value => <Pressable key={value} accessibilityRole="radio" accessibilityLabel={`${value}分`}
                  accessibilityState={{ checked: draft.maintenanceMinutes === value, disabled }} disabled={disabled}
                  style={[styles.choice, draft.maintenanceMinutes === value && styles.selected]}
                  onPress={() => { state.change({ maintenanceMinutes: value }); setMaintenanceOpen(false); }}>
                  <Text style={styles.label}>{value}分</Text>
                </Pressable>)}
              </View>}
              <Text style={styles.note}>これから必要な作業のみ。完了済みの場合は0分を選択してください。</Text>
            </View>

            <View style={styles.group}>
              <Text style={styles.label}>保管方法</Text>
              <View style={styles.row}>
                {Object.entries(storageMethods).map(([key, label]) => <Pressable key={key} accessibilityRole="radio" accessibilityLabel={label}
                  disabled={disabled} accessibilityState={{ checked: draft.storageMethod === key, disabled }}
                  style={[styles.cell, styles.choice, draft.storageMethod === key && styles.selected]}
                  onPress={() => state.change({ storageMethod: key as StorageMethod })}>
                  <Text style={styles.label}>{label}</Text>
                </Pressable>)}
              </View>
            </View>

            {source.plannedUnitPriceYen === null && <View style={styles.group}>
              <Text style={styles.label}>予定販売価格（1個あたり・円）</Text>
              <TextInput accessibilityLabel="予定販売価格（1個あたり・円）" keyboardType="decimal-pad" inputMode="decimal"
                editable={!disabled} value={draft.manualPrice} onChangeText={manualPrice => state.change({ manualPrice })} style={styles.input} />
              <Text style={styles.note}>入力した価格は計算条件として保存します。</Text>
            </View>}
            {(issues.length > 0 || state.error || state.readError || settingsError) && <View style={styles.errorBox}>
              {issues.map(issue => <Text key={issue.field} accessibilityRole="alert" style={styles.error}>{issueMessage(issue)}</Text>)}
              {missingStock && (onEdit ? <Action quiet label="在庫を編集する" onPress={onEdit} disabled={!!busy} /> : <Text style={styles.note}>在庫編集権限のあるスタッフへ登録を依頼してください。</Text>)}
              {missingArea && (onSettings ? <Action quiet label="カテゴリの保管面積設定を開く" disabled={!!busy} onPress={() => {
                setSettingsError("");
                void onSettings().catch(() => setSettingsError("設定ページを開けませんでした。"));
              }} /> : <Text style={styles.note}>管理者へ保管面積の設定を依頼してください。</Text>)}
              {state.error && <Text accessibilityRole="alert" style={styles.error}>{state.error}</Text>}
              {state.readError && <Text accessibilityRole="alert" style={styles.error}>{state.readError}</Text>}
              {settingsError && <Text accessibilityRole="alert" style={styles.error}>{settingsError}</Text>}
            </View>}
            {state.needsRecalculation && <Text accessibilityLiveRegion="polite" style={styles.warning}>{state.sourceChanged ? "元の在庫または設定が更新されています。" : state.inputsChanged ? "計算条件が変更されています。" : ""} 再計算が必要です。</Text>}
            <Action label={busy === "calculate" ? "計算中…" : plan ? "再計算" : "計算する"} disabled={disabled || missingStock} onPress={() => {
              scrollOnLayout.current = true;
              void state.calculate().then(success => {
                if (!success) scrollOnLayout.current = false;
                if (success && resultY.current) scroller.current?.scrollTo({ y: resultY.current, animated: true });
              });
            }} />
            {plan && <View onLayout={showResult} style={styles.group}>
              <QuantityResult plan={plan} />
              {canWrite && snapshot?.canEdit
                ? <Action label={busy === "save" ? "保存中…" : "計算結果を保存"} disabled={!state.canSave} onPress={() => void state.save()} />
                : <Text style={styles.note}>計算結果の保存には在庫の編集権限が必要です。</Text>}
            </View>}
          </ScrollView>
        </KeyboardAvoidingView>}
      </SafeAreaView>
    </Modal>
  </View>;
}

const styles = StyleSheet.create({
  panel: { borderTopColor: colors.border, borderTopWidth: 1, paddingTop: 14, gap: 10 },
  screen: { flex: 1, backgroundColor: "#fff" },
  header: { backgroundColor: "#fff", borderBottomColor: colors.border, borderBottomWidth: 1, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 6, paddingHorizontal: 14, gap: 8 },
  scroll: { padding: 14, paddingBottom: 32, gap: 18 },
  title: { fontSize: 17, fontWeight: "700", color: colors.text, flexShrink: 1 },
  card: { padding: 12, gap: 10, backgroundColor: "#fff", borderColor: colors.border, borderWidth: 1, borderRadius: 12 },
  group: { gap: 8 },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  cell: { flex: 1, minWidth: 0, gap: 3 },
  factGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 8 },
  sourceFact: { width: "49%", padding: 9, borderRadius: 8, backgroundColor: "#F2F5F4", gap: 4 },
  detailFact: { borderBottomColor: colors.border, borderBottomWidth: 1, paddingVertical: 6, gap: 3 },
  label: { fontSize: 13, fontWeight: "600", color: colors.text },
  metric: { fontSize: 21, fontWeight: "700", color: colors.text },
  allocation: { fontSize: 28, fontWeight: "800" },
  retailText: { color: "#065f46" },
  wholesaleText: { color: "#075985" },
  bar: { height: 11, flexDirection: "row", borderRadius: 6, overflow: "hidden", backgroundColor: "#0369a1" },
  body: { fontSize: 14, color: colors.text },
  note: { fontSize: 13, color: "#475569" },
  input: { minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: 8, marginTop: 4, paddingVertical: 6, paddingHorizontal: 8, fontSize: 17, color: colors.text },
  button: { alignItems: "center", justifyContent: "center", backgroundColor: "#065f46", borderRadius: 9, paddingHorizontal: 12, paddingVertical: 7, minHeight: 44 },
  secondary: { backgroundColor: "#fff", borderColor: colors.border, borderWidth: 1 },
  disabled: { opacity: 0.5 },
  buttonText: { fontWeight: "700", fontSize: 14, color: "#fff", textAlign: "center" },
  secondaryText: { color: colors.text },
  choice: { minHeight: 44, minWidth: 55, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 6 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  selected: { backgroundColor: "#d1fae5", borderColor: "#047857" },
  errorBox: { backgroundColor: "#fef2f2", padding: 9, borderRadius: 8, gap: 7 },
  error: { color: "#991b1b", fontSize: 14 },
  warning: { color: "#78350f", backgroundColor: "#fffbeb", borderRadius: 8, padding: 8, fontWeight: "700" },
});
