'use client';
import { useEffect, useMemo, useState } from 'react';
import { CatalogSelectionController, CatalogSelectionError, selectionDirty, type CatalogSelectionPorts } from '@/lib/inventory/partnerCatalogSelection';
const API = '/api/inventory/partner-catalog';
const button = 'min-h-[44px] rounded border border-gray-300 px-4 py-2 text-sm disabled:opacity-40';
async function request(url: string, body?: unknown) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal, ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (response.status === 409) throw new CatalogSelectionError('conflict', '別の端末で更新されました。');
    const value = await response.json(); if (!response.ok || !value.ok) throw new Error('共有内容を取得できませんでした。'); return value;
  } finally { clearTimeout(timer); }
}
export function PartnerCatalogSelection({ refreshVersion = '' }: { refreshVersion?: string }) {
  const controller = useMemo(() => {
    const ports: CatalogSelectionPorts = { list: async () => (await request(API)).grants, read: id => request(`${API}/selection?id=${encodeURIComponent(id)}`), save: async (id, revision, selectedIds) => (await request(`${API}/selection`, { id, revision, selectedIds })).grant, link: path => new URL(path, window.location.origin).href, copy: text => navigator.clipboard.writeText(text), open: async url => { window.open(url, '_blank', 'noopener,noreferrer'); } };
    return new CatalogSelectionController(ports);
  }, []);
  const [state, setState] = useState(controller.state), [query, setQuery] = useState('');
  useEffect(() => { const unsubscribe = controller.subscribe(setState); void controller.start(); return unsubscribe; }, [controller]);
  const unavailable = state.draft.filter(id => !state.data?.candidates.some(item => item.id === id)).length;
  useEffect(() => { if (refreshVersion) void controller.start(); }, [controller, refreshVersion]);
  const busy = state.loading || state.saving;
  const items = state.data?.candidates.filter(item => `${item.name} ${item.managementNumber} ${item.stageLabel}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? [];
  return <section className="mt-8 min-w-0 rounded-lg border border-gray-200 p-4 sm:p-6" aria-labelledby="selection-title">
    <h3 id="selection-title" className="text-lg font-bold text-[#214c3c]">共有する商品を選ぶ</h3><p className="mt-3 text-sm leading-7 text-gray-600">選んで保存した商品だけを、既存の共有リンクに表示します。チェック後に「選択を保存」を押してください。既存リンクの初期選択は0件です。</p>
    {state.error && <p role="alert" className="mt-4 rounded bg-red-50 p-3 text-sm leading-6 text-red-800">{state.error}</p>}{state.notice && <p role="status" className="mt-4 rounded bg-green-50 p-3 text-sm leading-6 text-green-900">{state.notice}</p>}
    <div className="mt-4 flex flex-wrap items-end gap-3">{state.grants.length > 1 && <label className="flex min-w-0 flex-1 flex-col gap-2 text-sm">共有先<select className="min-h-[44px] w-full rounded border bg-white p-2" value={state.id} disabled={busy} onChange={event => void controller.choose(event.target.value)}>{state.grants.map(grant => <option key={grant.id} value={grant.id}>{grant.label}{grant.disabled ? '（停止中）' : ''}</option>)}</select></label>}<button className={button} disabled={busy} onClick={() => void (controller.start())}>{state.loading ? '読み込み中…' : '最新内容を再読み込み'}</button></div>
    {!state.loading && !state.grants.length && <p className="mt-5 text-sm">上の操作で共有リンクを作成してから、再読み込みしてください。</p>}
    {state.data && <><p className="mt-5 break-all font-bold">{state.data.grant.label}：選択中 {state.draft.length}件 <span className="text-sm font-normal">{selectionDirty(state) ? '・未保存の変更あり' : '・保存済み'}</span></p><p className="mt-2 text-sm leading-6 text-gray-600">補修待ち・撮影待ち・出品待ちが対象です。全解除も保存すると共有商品が0件になります。</p>
      {unavailable > 0 && <div className="mt-3 text-sm"><p>販売済みなどで対象外になった選択が{unavailable}件あります。</p><button className={button} disabled={busy} onClick={() => controller.removeUnavailable()}>対象外の選択を解除</button></div>}
      <div className="mt-4 flex flex-wrap gap-3"><button className={button} disabled={busy || !state.draft.length} onClick={() => controller.clear()}>全解除</button><button className={`${button} bg-[#214c3c] text-white`} disabled={busy || state.conflict || !selectionDirty(state)} onClick={() => void controller.save()}>{state.saving ? '保存中…' : '選択を保存'}</button></div>
      <label className="mt-5 flex flex-col gap-2 text-sm">商品を検索<input className="min-h-[44px] min-w-0 rounded border border-gray-300 px-3" value={query} placeholder="商品名・管理SKU・作業段階" onChange={event => setQuery(event.target.value)} /></label><p className="my-4 text-xs text-gray-600">対象 {state.data.candidates.length}件・表示 {items.length}件</p>
      <ul className="space-y-3">{items.map(item => <li key={item.id}><label className={`flex min-h-[88px] cursor-pointer items-start gap-3 rounded-lg border p-3 ${state.draft.includes(item.id) ? 'border-green-700 bg-green-50' : 'border-gray-200'}`}><span className="flex min-h-[44px] min-w-[24px] items-center"><input type="checkbox" aria-label={`${item.name} ${item.stageLabel}`} className="h-5 w-5" disabled={busy} checked={state.draft.includes(item.id)} onChange={() => controller.toggle(item.id)} /></span>{item.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- Authenticated no-store images require the browser session and must bypass the optimizer.
        <img loading="lazy" alt={`${item.name}の写真`} src={item.imageUrl} className="h-[72px] w-[62px] shrink-0 rounded object-cover" />
      ) : <span className="flex h-[72px] w-[62px] shrink-0 items-center justify-center rounded bg-gray-100 text-[10px] text-gray-500">写真なし</span>}<span className="min-w-0 flex-1"><span className="block break-words text-sm font-medium leading-6">{item.name}</span><span className="mt-1 block text-xs text-green-800">{item.stageLabel}</span><span className="mt-1 block break-all text-xs text-gray-500">{item.managementNumber}</span></span></label></li>)}</ul>{!items.length && <p className="py-6 text-sm text-gray-600">該当する商品はありません。</p>}
    </>}
  </section>;
}
