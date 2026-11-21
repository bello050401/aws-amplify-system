import React, { useMemo, useRef, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CatalogSelectionError, type CatalogSelectionPorts } from '../../../lib/inventory/partnerCatalogSelection';
import type { CatalogGrant, PublicCatalogItem } from '../../../lib/inventory/partnerCatalog/types';
import { SnapshotStore } from '../domain/snapshot';
import { StaffApp, type StaffAppPorts } from '../ui/StaffApp';
import { photoPreviewImage, previewItems } from './fixture';

const params = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);
const initial: CatalogGrant = { id: 'fixture-existing', label: '既存の取引先リンク', title: '共有商品', createdAt: '2026-11-21T00:00:00Z', updatedAt: '2026-11-21T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', disabled: false, path: '/share/inventory/previewToken0000000000000000000000000000000000000000000000000000', revision: 0, selectedIds: [] };
const candidates: PublicCatalogItem[] = Array.from({ length: 7 }, (_, index) => ({ id: `fixture-${index}`, name: index === 0 ? '英国アンティーク オーク無垢材 ダイニングチェア 背もたれ彫刻入り 長い商品名も省略せずに最後まで確認できます' : ['チーク材 サイドボード', 'ヴィンテージ ラウンジチェア', '木製 ダイニングテーブル'][index % 3], managementNumber: `BELLO-${index + 1}`, quantity: 1, dimensions: { width: '50', depth: '45', height: '80' }, stage: (['repair', 'photo', 'listing'] as const)[index % 3], stageLabel: (['補修待ち', '撮影待ち', '出品待ち'] as const)[index % 3], imageUrl: index === 6 ? null : photoPreviewImage('共有候補 ' + (index + 1), '#94734f'), images: [] }));
export function NativePartnerCatalogPreview() {
  const [offline, setOffline] = useState(false), [failure, setFailure] = useState(false), [conflict, setConflict] = useState(false);
  const flags = useRef({ offline, failure, conflict }); flags.current = { offline, failure, conflict };
  const ports = useMemo<StaffAppPorts>(() => {
    const key = (id: string) => 'bello.partner-catalog-ui-preview.' + id;
    const readGrant = async (id: string) => { const value = await AsyncStorage.getItem(key(id)); return value ? JSON.parse(value) as CatalogGrant : { ...initial, id, label: id === initial.id ? initial.label : '取引先B', selectedIds: [] }; };
    const catalog: CatalogSelectionPorts = {
      list: async () => [await readGrant(initial.id), ...(params.has('multiple') ? [await readGrant('fixture-second')] : [])],
      read: async id => { if (flags.current.offline) throw Error('offline'); return { grant: await readGrant(id), candidates, maxSelectedItems: 500 }; },
      save: async (id, revision, selectedIds) => {
        await new Promise(resolve => setTimeout(resolve, 650));
        if (flags.current.offline || flags.current.failure) throw Error('offline');
        if (flags.current.conflict) throw new CatalogSelectionError('conflict', 'fixture conflict');
        const grant = await readGrant(id);
        if (grant.revision !== revision) throw new CatalogSelectionError('conflict', 'fixture conflict');
        const next = { ...grant, revision: revision + 1, selectedIds, updatedAt: new Date().toISOString() };
        await AsyncStorage.setItem(key(id), JSON.stringify(next)); return next;
      },
      link: path => new URL(path, 'https://catalog-ui-preview-long-hostname.example.invalid').href,
      copy: text => navigator.clipboard.writeText(text), open: async url => { await Linking.openURL(url); },
    };
    return { snapshot: new SnapshotStore(AsyncStorage, 'partner-preview', 'fixture'), online: async () => !flags.current.offline, newMutationId: () => 'fixture-mutation', loadInventory: async () => previewItems, save: async () => { throw Error('Preview only'); }, partnerCatalog: catalog };
  }, []);
  return <><View style={{ padding: 8, gap: 6, flexDirection: 'row', flexWrap: 'wrap' }}>{[['保存失敗', failure, setFailure], ['競合', conflict, setConflict]] .map(([label, active, setter]) => <Pressable key={String(label)} accessibilityRole="button" onPress={() => (setter as (value: boolean) => void)(!active)} style={{ minHeight: 44, padding: 10, backgroundColor: active ? '#FFDDDD' : '#EEEEEE' }}><Text>{String(label)} {active ? 'ON' : 'OFF'}</Text></Pressable>)}</View><StaffApp ports={ports} offline={offline} preview writesEnabled={!params.has('viewer')} canManagePartnerCatalog={!params.has('viewer')} features={{ sales: true, ecListing: true }} onToggleOffline={() => setOffline(value => !value)} /></>;
}
