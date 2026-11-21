import React, { useEffect, useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { CatalogSelectionController, selectionDirty, type CatalogSelectionPorts } from '../../../lib/inventory/partnerCatalogSelection';

export function PartnerCatalogScreen({ ports, offline, onClose, retainedController }: { ports: CatalogSelectionPorts; offline: boolean; onClose(): void; retainedController?: CatalogSelectionController }) {
  const controller = useMemo(() => retainedController ?? new CatalogSelectionController(ports), [ports, retainedController]);
  const [state, setState] = useState(controller.state);
  const [query, setQuery] = useState('');
  useEffect(() => { const unsubscribe = controller.subscribe(setState); if (!offline) void controller.start(); return unsubscribe; }, [controller, offline]);
  const busy = state.loading || state.saving;
  const items = state.data?.candidates.filter(item => `${item.name} ${item.managementNumber} ${item.stageLabel}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? [];
  const active = state.data && !state.data.grant.disabled && Date.parse(state.data.grant.expiresAt) > Date.now();
  const unavailable = state.draft.filter(id => !state.data?.candidates.some(item => item.id === id)).length;
  const action = (label: string, onPress: () => void, disabled = false, primary = false) => <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={[s.button, primary && s.primary, disabled && s.disabled]}><Text style={[s.buttonText, primary && { color: 'white' }]}>{label}</Text></Pressable>;
  return <View style={s.screen}>
    <View style={s.header}>{action('ホームへ戻る', onClose, state.saving)}<Text style={s.title}>社外共有</Text></View>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.content}>
      <Text style={s.description}>選んで保存した商品だけを、既存の共有リンクに表示します。補修待ち・撮影待ち・出品待ちの商品から選べます。</Text>
      {offline && <Text accessibilityRole="alert" style={s.error}>圏外です。選択は保持しています。通信が戻ってから保存してください。</Text>}
      {Boolean(state.error) && <Text accessibilityRole="alert" style={s.error}>{state.error}</Text>}
      {Boolean(state.notice) && <Text accessibilityRole="status" style={s.notice}>{state.notice}</Text>}
      {state.grants.length > 1 && <View style={s.box}><Text style={s.label}>共有先を選ぶ</Text>{state.grants.map(grant => <Pressable key={grant.id} accessibilityRole="radio" accessibilityState={{ selected: state.id === grant.id }} onPress={() => void controller.choose(grant.id)} disabled={busy || offline} style={[s.button, state.id === grant.id && s.selected]}><Text style={s.buttonText}>{state.id === grant.id ? '● ' : '○ '}{grant.label}{grant.disabled ? '（停止中）' : ''}</Text></Pressable>)}</View>}
      {action(state.loading ? '読み込み中…' : '最新内容を再読み込み', () => { void (controller.start()); }, busy || offline)}
      {!state.loading && !state.grants.length && <Text style={s.description}>共有リンクはありません。Web版の「社外共有」でリンクを作成してください。</Text>}
      {state.data && <>
        <View style={s.box}><Text style={s.label}>{state.data.grant.label}{!active ? '（停止中・期限切れ）' : ''}</Text><Text selectable style={s.url}>{ports.link(state.data.grant.path)}</Text><View style={s.actions}>{action(ports.copyLabel ?? 'リンクをコピー', () => { void controller.copy(); }, !active)}{action('共有ページを開く', () => { void controller.open(); }, !active || offline)}</View></View>
        {unavailable > 0 && <View style={s.box}><Text style={s.description}>販売済みなどで対象外になった選択が{unavailable}件あります。</Text>{action('対象外の選択を解除', () => controller.removeUnavailable(), busy)}</View>}
        <Text style={s.count}>選択中 {state.draft.length}件 {selectionDirty(state) ? '・未保存の変更あり' : '・保存済み'}</Text>
        <Text style={s.description}>チェック後に「選択を保存」を押してください。全解除も保存すると共有商品が0件になります。</Text>
        <View style={s.actions}>{action('全解除', () => controller.clear(), busy || !state.draft.length)}{action(state.saving ? '保存中…' : '選択を保存', () => { void controller.save(); }, busy || offline || state.conflict || !selectionDirty(state), true)}</View>
        <TextInput accessibilityLabel="共有する商品を検索" placeholder="商品名・管理SKU・作業段階で検索" value={query} onChangeText={setQuery} style={s.search} />
        <Text style={s.description}>対象 {state.data.candidates.length}件・表示 {items.length}件</Text>
        {items.map(item => { const checked = state.draft.includes(item.id); return <Pressable key={item.id} accessibilityRole="checkbox" accessibilityLabel={`${item.name} ${item.stageLabel}`} accessibilityState={{ checked, disabled: busy }} disabled={busy} onPress={() => controller.toggle(item.id)} style={[s.row, checked && s.selected]}>
          <Text style={s.check}>{checked ? '☑' : '☐'}</Text>
          {item.imageUrl ? <Image alt={`${item.name}の写真`} accessibilityLabel={`${item.name}の写真`} source={{ uri: item.imageUrl.startsWith('/') ? ports.link(item.imageUrl) : item.imageUrl, headers: state.data?.imageHeaders }} style={s.photo} /> : <View style={[s.photo, s.placeholder]}><Text style={s.small}>写真なし</Text></View>}
          <View style={s.itemText}><Text style={s.name}>{item.name}</Text><Text style={s.stage}>{item.stageLabel}</Text><Text style={s.small}>{item.managementNumber}</Text></View>
        </Pressable>; })}
        {!items.length && <Text style={s.description}>該当する商品はありません。</Text>}
      </>}
    </ScrollView>
  </View>;
}
const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F8F6F1' }, header: { padding: 12, gap: 12, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }, title: { fontSize: 21, fontWeight: '700', color: '#263D3C' },
  content: { padding: 16, gap: 14, width: '100%', maxWidth: 760, alignSelf: 'center', paddingBottom: 32 }, description: { fontSize: 13, lineHeight: 22, color: '#53665D' },
  button: { minHeight: 44, justifyContent: 'center', alignItems: 'center', padding: 12, borderRadius: 10, borderWidth: 1, borderColor: '#AABAB0', backgroundColor: 'white', flexShrink: 1 }, buttonText: { fontSize: 14, color: '#214C3C', fontWeight: '600' }, primary: { backgroundColor: '#214C3C' }, disabled: { opacity: .45 },
  box: { backgroundColor: 'white', borderRadius: 12, padding: 14, gap: 12, borderWidth: 1, borderColor: '#DBE2DA' }, label: { fontSize: 15, fontWeight: '700', color: '#263D3C' }, url: { fontSize: 12, color: '#53665D', flexShrink: 1 }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  count: { fontSize: 17, fontWeight: '700', color: '#214C3C' }, search: { minHeight: 48, borderWidth: 1, borderColor: '#AABAB0', borderRadius: 10, padding: 12, fontSize: 14, backgroundColor: 'white' },
  row: { flexDirection: 'row', gap: 10, padding: 12, borderWidth: 1, borderColor: '#DDE3DA', borderRadius: 12, backgroundColor: 'white', alignItems: 'flex-start', minHeight: 96 }, selected: { borderColor: '#36746A', backgroundColor: '#EFF7F0' }, check: { fontSize: 25, color: '#214C3C' }, photo: { width: 62, height: 70, borderRadius: 6, resizeMode: 'cover' }, placeholder: { backgroundColor: '#E6EAE4', justifyContent: 'center', alignItems: 'center' }, itemText: { flex: 1, minWidth: 0, gap: 5 }, name: { fontSize: 15, fontWeight: '600', color: '#263D3C', lineHeight: 23 }, stage: { fontSize: 12, color: '#36746A' }, small: { fontSize: 10, color: '#69796E' }, error: { padding: 12, color: '#9C2222', backgroundColor: '#FFF0EC', fontSize: 13, lineHeight: 22 }, notice: { padding: 12, color: '#214C3C', backgroundColor: '#E7F1E7', fontSize: 13, lineHeight: 22 },
});
