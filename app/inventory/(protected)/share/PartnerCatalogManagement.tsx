'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CatalogGrant, CatalogManagementResponse } from '@/lib/inventory/partnerCatalog/types';
import { catalogMutation } from './catalogMutation';

const API = '/api/inventory/partner-catalog';
const button = 'min-h-[44px] rounded border border-gray-300 px-4 py-2 text-sm disabled:opacity-50 hover:bg-gray-50';
const date = (value: string) => new Date(value).toLocaleString('ja-JP');

export function PartnerCatalogManagement() {
  const [grants, setGrants] = useState<CatalogGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [label, setLabel] = useState('取引先共有');
  const [confirm, setConfirm] = useState<{ action: 'renew' | 'disable'; grant: CatalogGrant } | null>(null);
  const confirmation = useRef<HTMLDialogElement>(null);
  const fetchList = useCallback(async () => {
    setLoading(true); setError('');
    try { const response = await fetch(API, { cache: 'no-store' }); const result: CatalogManagementResponse = await response.json(); if (!response.ok || !result.ok) throw new Error(); setGrants(result.grants); }
    catch { setError('共有リンクを取得できませんでした。再読み込みをお試しください。'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void fetchList(); }, [fetchList]);
  useEffect(() => { if (confirm) confirmation.current?.showModal(); else confirmation.current?.close(); }, [confirm]);

  async function mutate(action: 'create' | 'renew' | 'disable', id?: string) {
    setPending(true); setError(''); setNotice('');
    try {
      const response = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(catalogMutation(action, label, id)) });
      const result: { ok: boolean; grant?: CatalogGrant } = await response.json();
      if (!response.ok || !result.ok || !result.grant) throw new Error(response.status === 403 ? '権限を確認できません。ログインし直してからお試しください。' : response.status === 409 ? '別の操作で更新されました。再読み込みしてからお試しください。' : '操作に失敗しました。時間をおいて再度お試しください。');
      const grant = result.grant;
      setGrants(current => current.some(item => item.id === grant.id) ? current.map(item => item.id === grant.id ? grant : item) : [grant, ...current]);
      setConfirm(null); setNotice(action === 'create' ? '共有リンクを作成しました。リンクをコピーして共有できます。' : action === 'renew' ? '新しいリンクに更新しました。以前のリンクは利用できません。新しいリンクを共有してください。' : '共有を停止しました。リンクから商品を閲覧できなくなりました。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '操作に失敗しました。'); setConfirm(null); }
    finally { setPending(false); }
  }

  async function copy(grant: CatalogGrant) {
    setNotice(''); setError('');
    try { await navigator.clipboard.writeText(new URL(grant.path, window.location.origin).href); setNotice('共有リンクをコピーしました。'); }
    catch { setError('リンクをコピーできませんでした。下のリンク欄から選択してコピーしてください。'); }
  }

  return <section className="py-8"><h2 className="text-2xl font-medium text-[#214c3c]">取引先用の商品カタログ</h2><p className="mt-4 text-sm leading-7 text-gray-600">補修待ち・撮影待ち・出品待ちの商品を、ログイン不要の閲覧専用ページで共有します。<br />写真・商品名・管理SKU・数量・寸法・作業段階を表示します。</p><p className="mt-3 text-sm leading-7 text-gray-600">リンクを知っている方が閲覧できます。共有先を確認してお渡しください。有効期間は90日です。</p>
    <form className="mt-6 flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-gray-50 p-5" onSubmit={event => { event.preventDefault(); void mutate('create'); }}><label className="flex min-w-0 flex-1 flex-col gap-2 text-sm">管理用の名前<input className="min-h-[44px] rounded border border-gray-300 bg-white px-3" value={label} maxLength={80} onChange={event => setLabel(event.target.value)} placeholder="例：取引先A様" /></label><button className={`${button} bg-[#214c3c] text-white hover:bg-[#193b2e]`} disabled={pending || loading} type="submit">90日間の共有リンクを作成</button></form>
    {error && <p role="alert" className="my-5 rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</p>}{notice && <p role="status" className="my-5 rounded border border-green-200 bg-green-50 p-4 text-sm text-green-900">{notice}</p>}
    <div className="mb-4 mt-8 flex items-center justify-between gap-3"><h3 className="font-bold">共有リンク {grants.length}件</h3><button className={button} type="button" disabled={loading || pending} onClick={() => void fetchList()}>再読み込み</button></div>
    {loading ? <p role="status" className="py-6 text-sm">共有リンクを読み込んでいます…</p> : grants.length === 0 ? <p className="rounded border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">共有リンクはまだありません。</p> : <ul className="space-y-4">{grants.map(grant => { const expired = new Date(grant.expiresAt).getTime() <= Date.now(); const active = !grant.disabled && !expired; return <li key={grant.id} className="min-w-0 rounded-lg border border-gray-200 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h4 className="break-all font-bold">{grant.label}</h4><span className={`rounded px-2 py-1 text-xs ${active ? 'bg-green-50 text-green-800' : 'bg-gray-100 text-gray-600'}`}>{grant.disabled ? '共有停止中' : expired ? '期限切れ' : '共有中'}</span></div><dl className="mt-3 space-y-1 text-xs leading-6 text-gray-500"><div>有効期限：<time dateTime={grant.expiresAt}>{date(grant.expiresAt)}</time></div><div>作成：{date(grant.createdAt)}</div></dl><label className="mt-3 block text-xs text-gray-600">共有リンク<input className="mt-1 w-full min-w-0 rounded border border-gray-200 bg-gray-50 p-3 text-xs" readOnly value={typeof window !== 'undefined' ? new URL(grant.path, window.location.origin).href : grant.path} onFocus={event => event.target.select()} /></label><div className="mt-4 flex flex-wrap gap-2"><button className={button} disabled={!active || pending} type="button" onClick={() => void copy(grant)}>リンクをコピー</button>{active && <a className={`${button} inline-flex items-center`} href={grant.path} target="_blank" rel="noopener noreferrer">共有ページを確認 ↗</a>}<button className={button} disabled={pending} type="button" onClick={() => setConfirm({ action: 'renew', grant })}>リンクを更新</button><button className={`${button} text-red-700`} disabled={grant.disabled || pending} type="button" onClick={() => setConfirm({ action: 'disable', grant })}>共有を停止</button></div></li>; })}</ul>}
    <dialog ref={confirmation} className="w-[calc(100%_-_32px)] max-w-lg rounded-lg p-6 backdrop:bg-black/40" onCancel={event => { if (pending) event.preventDefault(); else setConfirm(null); }} aria-labelledby="share-confirm-title"><h3 id="share-confirm-title" className="text-lg font-bold">{confirm?.action === 'disable' ? '共有を停止しますか？' : '共有リンクを更新しますか？'}</h3><p className="mt-4 break-all text-sm leading-7">「{confirm?.grant.label}」{confirm?.action === 'disable' ? 'への共有を停止します。現在のリンクから商品を閲覧できなくなります。' : 'の新しいリンクを90日間有効で発行します。現在のリンクは利用できなくなります。更新後は、新しいリンクを取引先へお渡しください。'}</p><div className="mt-6 flex flex-wrap justify-end gap-3"><button type="button" className={button} disabled={pending} onClick={() => setConfirm(null)}>キャンセル</button><button type="button" className={`${button} bg-[#214c3c] text-white`} disabled={pending} onClick={() => { if (confirm) void mutate(confirm.action, confirm.grant.id); }}>{pending ? '処理中…' : confirm?.action === 'disable' ? '共有を停止する' : '更新する'}</button></div></dialog>
  </section>;
}
