'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export function CategoryMultiSelect({ value, onChange, options, compact = false, disabled = false, label = "カテゴリ（複数選択）" }: {
  value: string[]; onChange: (ids: string[]) => void; options: { id: string; name: string }[]; compact?: boolean; disabled?: boolean; label?:string;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [draft, setDraft] = useState<string[]>([]);
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null), id = useId();
  const [position, setPosition] = useState({ top: 0, left: 0, width: 340, height: 450 });
  const dirty = JSON.stringify(draft) !== JSON.stringify(value);
  const close = () => { setOpen(false); setQuery(''); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = trigger.current?.getBoundingClientRect(); if (!r) return;
      const width = Math.min(380, window.innerWidth - 24), height = Math.min(460, window.innerHeight - 32);
      setPosition({ width, height, left: Math.max(12, Math.min(r.left, window.innerWidth - width - 12)), top: Math.max(12, Math.min(r.bottom + 6, window.innerHeight - height - 12)) });
    };
    place(); search.current?.focus();
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('resize', place); };
  }, [open]);
  useEffect(()=>{if(!open||!dirty)return;const leave=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',leave);return()=>window.removeEventListener('beforeunload',leave);},[open,dirty]);
  const names = new Map(options.map(o => [o.id, o.name]));
  const toggle = (key: string) => setDraft(ids => ids.includes(key) ? ids.filter(v => v !== key) : [...ids, key]);
  const chips = (ids: string[], remove?: (key: string) => void) => <span className="flex flex-wrap gap-1">{ids.map(key => <span key={key} className="inline-flex items-center gap-1 rounded bg-teal-50 px-2 py-1 text-xs text-teal-900">
    {names.get(key) ?? '現在のカテゴリ'}{remove && <button type="button" aria-label={`${names.get(key) ?? 'カテゴリ'}を解除`} className="min-h-6 min-w-6 rounded hover:bg-teal-100" onClick={() => remove(key)}>×</button>}
  </span>)}</span>;
  return <div className="min-w-0">
    {!compact && <span className="mb-1 block text-sm text-gray-600">カテゴリ（複数選択）</span>}
    <button ref={trigger} type="button" disabled={disabled} aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={id}
      onClick={() => { setDraft([...value]); setOpen(true); }} className="flex min-h-11 w-full items-center justify-between gap-2 rounded border border-gray-300 bg-white px-2 py-1.5 text-left disabled:opacity-50">
      {value.length ? chips(value) : <span className="text-sm text-gray-500">カテゴリを選択</span>}<span aria-hidden>⌄</span>
    </button>
    {open && createPortal(<div className="fixed inset-0 z-[100] bg-black/10" onClick={event => {
      if (event.target === event.currentTarget && (!dirty || window.confirm('カテゴリの未保存の選択を破棄しますか？'))) close();
    }}><div ref={panel} id={id} role="dialog" aria-modal="true" aria-labelledby={id + '-title'} style={{ position: 'fixed', top: position.top, left: position.left, width: position.width, height: position.height }}
      className="flex flex-col rounded-xl border border-gray-200 bg-white p-4 shadow-xl" onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); if (!dirty || window.confirm('カテゴリの未保存の選択を破棄しますか？')) close(); }
        if (event.key === 'Tab') {
          const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)') ?? []);
          if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
          else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
        }
      }}>
      <h3 id={id + '-title'} className="mb-3 font-semibold">カテゴリを選択</h3>
      <div className="mb-3 max-h-24 overflow-auto">{chips(draft, toggle)}</div>
      <input ref={search} aria-label="カテゴリを検索" value={query} onChange={e => setQuery(e.target.value)} placeholder="カテゴリを検索" className="mb-2 min-h-11 w-full rounded border px-3 text-base" />
      <div className="min-h-0 flex-1 overflow-y-auto">{options.filter(o => o.name.normalize('NFKC').toLowerCase().includes(query.normalize('NFKC').toLowerCase())).map(o =>
        <label key={o.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded px-2 hover:bg-teal-50"><input type="checkbox" checked={draft.includes(o.id)} onChange={() => toggle(o.id)} className="h-4 w-4 accent-teal-700" />{o.name}</label>)}</div>
      <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3"><span className="text-xs text-gray-500">{draft.length}件選択</span>
        <button type="button" className="min-h-11 rounded border px-3 text-sm" onClick={close}>キャンセル</button>
        <button type="button" disabled={draft.length > 20} className="min-h-11 rounded bg-teal-800 px-5 text-sm text-white disabled:opacity-50" onClick={() => { onChange([...draft]); close(); }}>保存</button>
      </div>
      {draft.length > 20 && <p role="alert" className="mt-2 text-sm text-red-700">20個以内で選択してください。</p>}
    </div></div>, document.body)}
  </div>;
}
