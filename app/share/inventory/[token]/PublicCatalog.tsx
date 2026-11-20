'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PublicCatalogItem, PublicCatalogResponse } from '@/lib/inventory/partnerCatalog/types';
import s from './catalog.module.css';

const STAGES = [{ id: 'all', label: 'すべて' }, { id: 'repair', label: '補修待ち' }, { id: 'photo', label: '撮影待ち' }, { id: 'listing', label: '出品待ち' }] as const;
const dateLabel = (value: string) => new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const dimensionLabel = (value: string | null) => !value ? '—' : /[m㎝㎜]/i.test(value.normalize('NFKC')) ? value : `${value} cm`;

function CatalogPhoto({ src, name, gallery = false }: { src: string; name: string; gallery?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return failed ? <span className={s.imageError}>写真を読み込めませんでした。<br />時間をおいて再度お試しください。</span> : <img src={src} alt={name} loading={gallery ? 'eager' : 'lazy'} referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

function Gallery({ item, onClose }: { item: PublicCatalogItem; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const close = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const images = item.images.length ? item.images : item.imageUrl ? [item.imageUrl] : [];
  const move = useCallback((delta: number) => setIndex(current => (current + delta + images.length) % images.length), [images.length]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    close.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight') move(1);
      if (event.key === 'ArrowLeft') move(-1);
      if (event.key === 'Tab') {
        const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
        if (!buttons?.length) return;
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', key); previous?.focus(); };
  }, [move, onClose]);
  return <div className={s.overlay} ref={dialog} role="dialog" aria-modal="true" aria-labelledby="gallery-title"
    onTouchStart={event => { const t = event.touches[0]; touch.current = { x: t.clientX, y: t.clientY }; }}
    onTouchEnd={event => { const start = touch.current; touch.current = null; if (!start) return; const t = event.changedTouches[0], dx = t.clientX - start.x, dy = t.clientY - start.y; if (dy > 110 && Math.abs(dx) < 70) onClose(); else if (Math.abs(dx) > 70 && Math.abs(dy) < 70) move(dx < 0 ? 1 : -1); }}>
    <div className={s.galleryTop}><div className={s.galleryTitle} id="gallery-title">{item.name}</div><button ref={close} className={s.close} type="button" onClick={onClose} aria-label="写真を閉じる">×</button></div>
    <div className={s.galleryImage}><CatalogPhoto src={images[index]} name={`${item.name} 写真 ${index + 1}`} gallery /></div>
    <div className={s.galleryBottom}><button type="button" className={s.arrow} disabled={images.length < 2} onClick={() => move(-1)} aria-label="前の写真">‹</button><span aria-live="polite">{index + 1} / {images.length}</span><button type="button" className={s.arrow} disabled={images.length < 2} onClick={() => move(1)} aria-label="次の写真">›</button></div>
    <p className={s.galleryHint}>左右にスワイプで写真を切り替え・下にスワイプで閉じる</p>
  </div>;
}

export function PublicCatalog({ token }: { token: string }) {
  const [data, setData] = useState<PublicCatalogResponse | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<'unavailable' | 'invalid' | null>(null);
  const [stage, setStage] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<PublicCatalogItem | null>(null);
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/shared-inventory/${encodeURIComponent(token)}`, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
      if (!response.ok) { setData(null); setSelected(null); setError(response.status === 404 ? 'invalid' : 'unavailable'); return; }
      const result: PublicCatalogResponse = await response.json();
      if (!result.ok || !Array.isArray(result.items)) throw new Error('invalid-response');
      setData(result); setSelected(null);
    } catch { if (!controller.signal.aborted) { setData(null); setSelected(null); setError('unavailable'); } }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }, [token]);
  useEffect(() => { void load(); return () => request.current?.abort(); }, [load]);
  const closeGallery = useCallback(() => setSelected(null), []);
  const items = useMemo(() => (data?.items ?? []).filter(item => (stage === 'all' || item.stage === stage) && `${item.name} ${item.managementNumber}`.normalize('NFKC').toLocaleLowerCase().includes(search.trim().normalize('NFKC').toLocaleLowerCase())), [data, search, stage]);
  const counts = useMemo(() => Object.fromEntries(STAGES.map(entry => [entry.id, entry.id === 'all' ? data?.items.length ?? 0 : data?.items.filter(item => item.stage === entry.id).length ?? 0])), [data]);

  return <main className={s.page}><div className={s.shell}>
    <header className={s.header}><div className={s.wordmark}>BELLO</div><div className={s.eyebrow}>PARTNER COLLECTION</div></header>
    <section className={s.hero} aria-labelledby="catalog-title"><h1 id="catalog-title">{data?.title || 'BELLO 商品カタログ'}</h1><p className={s.description}>補修・撮影・出品準備中の商品一覧です。</p>
      {data && <div className={s.update}><span>最終確認：{dateLabel(data.checkedAt)}</span><button className={s.button} type="button" disabled={busy} onClick={() => void load()}>{busy ? '更新中…' : '最新の情報に更新'}</button></div>}
    </section>
    {data && <><section className={s.tools} aria-label="商品を絞り込む"><div className={s.stages}>{STAGES.map(entry => <button key={entry.id} type="button" className={s.stage} aria-pressed={stage === entry.id} onClick={() => setStage(entry.id)}>{entry.label}<span>{counts[entry.id]}</span></button>)}</div><label className={s.searchBox}><span aria-hidden="true">⌕</span><span className="sr-only">商品名・管理番号で検索</span><input className={s.search} type="search" placeholder="商品名・管理番号で検索" value={search} onChange={event => setSearch(event.target.value)} /></label></section>
      <div className={s.summary} role="status"><strong>{items.length}</strong>件を表示 / 全{data.items.length}件{busy && ' · 更新中…'}</div>
      {items.length ? <section className={s.grid} aria-label="商品一覧">{items.map(item => <article key={item.id} className={s.card}>{item.imageUrl ? <button type="button" className={s.photo} onClick={() => setSelected(item)} aria-label={`${item.name}の写真を拡大`}><CatalogPhoto src={item.imageUrl} name={item.name} /><span className={s.photoCount}>{Math.max(item.images.length, 1)} 枚 · 拡大</span></button> : <div className={s.photo}><span className={s.noPhoto}>写真準備中</span></div>}<span className={s.badge}>{item.stageLabel}</span><h2>{item.name || '商品名未登録'}</h2><dl className={s.details}><dt>管理番号</dt><dd>{item.managementNumber || '—'}</dd><dt>数量</dt><dd>{item.quantity} 点</dd><dt>サイズ</dt><dd>幅 {dimensionLabel(item.dimensions.width)} × 奥行 {dimensionLabel(item.dimensions.depth)} × 高さ {dimensionLabel(item.dimensions.height)}</dd></dl></article>)}</section> : <div className={s.state}><h2>{data.items.length ? '条件に合う商品がありません' : '現在、掲載対象の商品はありません'}</h2><p>{data.items.length ? '商品名や管理番号、作業段階を変えてお試しください。' : '準備中の商品が追加されるまでお待ちください。'}</p>{data.items.length > 0 && <button type="button" className={s.button} onClick={() => { setSearch(''); setStage('all'); }}>絞り込みを解除</button>}</div>}</>}
    {busy && !data && <div className={s.state} role="status"><div className={s.loading} />商品を読み込んでいます…</div>}
    {error && <div className={s.state} role="alert"><h2>{error === 'invalid' ? 'この共有リンクは利用できません' : '商品を読み込めませんでした'}</h2><p>{error === 'invalid' ? '有効期限が切れたか、共有が終了しています。担当者へ新しいリンクをご確認ください。' : '通信状況をご確認のうえ、もう一度お試しください。'}</p><button type="button" className={s.button} onClick={() => void load()}>再読み込み</button></div>}
    <footer className={s.footer}><span>BELLO · 家具と暮らしの新しい出会い</span><span>掲載内容は更新時点の情報です。</span></footer>
  </div>{selected && <Gallery item={selected} onClose={closeGallery} />}</main>;
}
