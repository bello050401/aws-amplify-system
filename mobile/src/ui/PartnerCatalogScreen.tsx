import React, { useEffect, useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { CatalogSelectionController, selectionDirty, type CatalogSelectionPorts } from '../../../lib/inventory/partnerCatalogSelection';

export function PartnerCatalogScreen({ ports, offline, onClose, retainedController }: { ports: CatalogSelectionPorts; offline: boolean; onClose(): void; retainedController?: CatalogSelectionController }) {
  const controller = useMemo(() => retainedController ?? new CatalogSelectionController(ports), [ports, retainedController]);
  const [state, setState] = useState(controller.state);
  const [query, setQuery] = useState('');
  const [registered, setRegistered] = useState(false);
  useEffect(() => { const unsubscribe = controller.subscribe(setState); if (!offline) void controller.start(); return unsubscribe; }, [controller, offline]);
  const busy = state.loading || state.saving;
  const candidates = state.data?.candidates.filter(item => !state.data?.grant.selectedIds.includes(item.id)) ?? [];
  const registeredItems = state.data?.grant.selectedIds.map(id => state.data!.candidates.find(item => item.id === id) ?? { id, name: '対象外の商品', managementNumber: id, stageLabel: '現在の共有対象外', imageUrl: null }) ?? [];
  const unavailableRegistered = registeredItems.filter(item => !state.data?.candidates.some(candidate => candidate.id === item.id)).length;
  const items = (registered ? registeredItems : candidates).filter(item => `${item.name} ${item.managementNumber} ${item.stageLabel}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? [];
  const active = state.data && !state.data.grant.disabled && Date.parse(state.data.grant.expiresAt) > Date.now();
  const unavailable = state.draft.filter(id => !state.data?.candidates.some(item => item.id === id)).length;
  const action = (label: string, onPress: () => void, disabled = false, primary = false) => <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={[s.button, primary && s.primary, disabled && s.disabled]}><Text style={[s.buttonText, primary && { color: 'white' }]}>{label}</Text></Pressable>;
  return <View style={s.screen}>
    <View style={s.header}>{action('ホームへ戻る', onClose, state.saving)}<Text style={s.title}>社外共有</Text></View>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.content}>
      <Text style={s.description}>商品を選んで登録すると共有リンクに追加され、候補一覧から消えます。補修待ち・撮影待ち・出品待ちの商品から選べます。</Text>
      {offline && <Text accessibilityRole="alert" style={s.error}>圏外です。選択は保持しています。通信が戻ってから保存してください。</Text>}
      {Boolean(state.error) && <Text accessibilityRole="alert" style={s.error}>{state.error}</Text>}
      {Boolean(state.notice) && <Text accessibilityRole="status" style={s.notice}>{state.notice}</Text>}
      {state.grants.length > 1 && <View style={s.box}><Text style={s.label}>共有先を選ぶ</Text>{state.grants.map(grant => <Pressable key={grant.id} accessibilityRole="radio" accessibilityState={{ selected: state.id === grant.id }} onPress={() => void controller.choose(grant.id)} disabled={busy || offline} style={[s.button, state.id === grant.id && s.selected]}><Text style={s.buttonText}>{state.id === grant.id ? '● ' : '○ '}{grant.label}{grant.disabled ? '（停止中）' : ''}</Text></Pressable>)}</View>}
      {action(state.loading ? '読み込み中…' : '最新内容を再読み込み', () => { void (controller.start()); }, busy || offline)}
      {!state.loading && !state.grants.length && <Text style={s.description}>共有リンクはありません。Web版の「社外共有」でリンクを作成してください。</Text>}
      {state.data && <>
        <View style={s.box}><Text style={s.label}>{state.data.grant.label}{!active ? '（停止中・期限切れ）' : ''}</Text><Text selectable style={s.url}>{ports.link(state.data.grant.path)}</Text><View style={s.actions}>{action(ports.copyLabel ?? 'リンクをコピー', () => { void controller.copy(); }, !active)}{action('共有ページを開く', () => { void controller.open(); }, !active || offline)}</View></View>
        {unavailable > 0 && <View style={s.box}><Text style={s.description}>販売済みなどで対象外になった選択が{unavailable}件あります。</Text>{action('対象外の選択を解除', () => controller.removeUnavailable(), busy)}</View>}
        <Text style={s.count}>登録済み {state.data.grant.selectedIds.length}件・選択中 {state.draft.length}件 {selectionDirty(state) ? '・未登録' : ''}</Text>
        <Text style={s.description}>チェック後に「選択した商品を登録」を押してください。全選択は検索結果の候補、全解除は未登録の選択すべてに適用します。</Text>
        <View style={s.actions}>{action('登録候補（' + candidates.length + '件）', () => setRegistered(false), false, !registered)}{action('登録済み（' + registeredItems.length + '件）', () => setRegistered(true), false, registered)}</View>
        {!registered && <View style={s.actions}>{action('全選択', () => controller.selectAll(items.map(item => item.id)), busy || !items.length)}{action('全解除', () => controller.clear(), busy || !state.draft.length)}</View>}
        {registered && unavailableRegistered > 0 && <View style={s.box}><Text style={s.description}>販売済みなどで対象外の登録が{unavailableRegistered}件あります。</Text>{action('対象外の登録を解除', () => { void controller.deregisterUnavailable(); }, busy || offline || state.conflict)}</View>}
        <TextInput accessibilityLabel="共有する商品を検索" placeholder="商品名・管理SKU・作業段階で検索" value={query} onChangeText={setQuery} style={s.search} />
        <Text style={s.description}>{registered ? '登録済み' : '登録候補'} {registered ? registeredItems.length : candidates.length}件・表示 {items.length}件</Text>
        {items.map(item => {
          const checked = state.draft.includes(item.id);
          const content = <>
            {!registered && <Text style={s.check}>{checked ? '☑' : '☐'}</Text>}
            {item.imageUrl ? <Image alt={`${item.name}の写真`} accessibilityLabel={`${item.name}の写真`} source={{ uri: item.imageUrl.startsWith('/') ? ports.link(item.imageUrl) : item.imageUrl, headers: state.data?.imageHeaders }} style={s.photo} /> : <View style={[s.photo, s.placeholder]}><Text style={s.small}>写真なし</Text></View>}
            <View style={s.itemText}>
              <Text style={s.name}>{item.name}</Text><Text style={s.stage}>{item.stageLabel}</Text><Text style={s.small}>{item.managementNumber}</Text>
              {registered && <Pressable accessibilityRole="button" accessibilityLabel={`${item.name}の登録を解除`} disabled={busy || offline || state.conflict} onPress={() => { void controller.deregister(item.id); }} style={[s.button, (busy || offline || state.conflict) && s.disabled]}><Text style={s.buttonText}>登録解除</Text></Pressable>}
            </View>
          </>;
          return registered
            ? <View key={item.id} style={[s.row]}>{content}</View>
            : <Pressable key={item.id} accessibilityRole="checkbox" accessibilityLabel={`${item.name} ${item.stageLabel}`} accessibilityState={{ checked, disabled: busy }} disabled={busy} onPress={() => controller.toggle(item.id)} style={[s.row, checked && s.selected]}>{content}</Pressable>;
        })}
        {!items.length && <Text style={s.description}>該当する商品はありません。</Text>}
      </>}
    </ScrollView>
    {state.data && state.draft.length > 0 && <View style={s.footer}>{action(state.saving ? '保存中…' : '選択した商品を登録（' + state.draft.length + '件）', () => { void controller.save(); }, busy || offline || state.conflict || !selectionDirty(state), true)}</View>}
  </View>;
}
const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F8F6F1' }, header: { padding: 12, gap: 12, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }, title: { fontSize: 21, fontWeight: '700', color: '#263D3C' },
  content: { padding: 16, gap: 14, width: '100%', maxWidth: 760, alignSelf: 'center', paddingBottom: 32 }, description: { fontSize: 13, lineHeight: 22, color: '#53665D' },
  button: { minHeight: 44, justifyContent: 'center', alignItems: 'center', padding: 12, borderRadius: 10, borderWidth: 1, borderColor: '#AABAB0', backgroundColor: 'white', flexShrink: 1 }, buttonText: { fontSize: 14, color: '#214C3C', fontWeight: '600' }, primary: { backgroundColor: '#214C3C' }, disabled: { opacity: .45 },
  box: { backgroundColor: 'white', borderRadius: 12, padding: 14, gap: 12, borderWidth: 1, borderColor: '#DBE2DA' }, label: { fontSize: 15, fontWeight: '700', color: '#263D3C' }, url: { fontSize: 12, color: '#53665D', flexShrink: 1 }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  footer: { padding: 12, borderTopWidth: 1, borderTopColor: '#DBE2DA', backgroundColor: 'white' },
  count: { fontSize: 17, fontWeight: '700', color: '#214C3C' }, search: { minHeight: 48, borderWidth: 1, borderColor: '#AABAB0', borderRadius: 10, padding: 12, fontSize: 14, backgroundColor: 'white' },
  row: { flexDirection: 'row', gap: 10, padding: 12, borderWidth: 1, borderColor: '#DDE3DA', borderRadius: 12, backgroundColor: 'white', alignItems: 'flex-start', minHeight: 96 }, selected: { borderColor: '#36746A', backgroundColor: '#EFF7F0' }, check: { fontSize: 25, color: '#214C3C' }, photo: { width: 62, height: 70, borderRadius: 6, resizeMode: 'cover' }, placeholder: { backgroundColor: '#E6EAE4', justifyContent: 'center', alignItems: 'center' }, itemText: { flex: 1, minWidth: 0, gap: 5 }, name: { fontSize: 15, fontWeight: '600', color: '#263D3C', lineHeight: 23 }, stage: { fontSize: 12, color: '#36746A' }, small: { fontSize: 10, color: '#69796E' }, error: { padding: 12, color: '#9C2222', backgroundColor: '#FFF0EC', fontSize: 13, lineHeight: 22 }, notice: { padding: 12, color: '#214C3C', backgroundColor: '#E7F1E7', fontSize: 13, lineHeight: 22 },
});
