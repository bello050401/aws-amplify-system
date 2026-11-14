'use client';

import {AnalysisMasters} from './AnalysisMasters';

import {useEffect,useState} from 'react';
import type {InventoryMetadata,ProductCategory} from '../../../../../lib/inventory/analysis/types';
import type {AnalysisManagementPorts,AnalysisMetadataView,AnalysisMetadataWrite} from '../../../../../lib/inventory/analysisUi/management';

export function AnalysisManagement({ports,inventoryId}:{
  ports:AnalysisManagementPorts; inventoryId?:string;
}) {
  const [opened,setOpened] = useState(false);
  return <details className="analysis-card" onToggle={event=>{if(event.currentTarget.open)setOpened(true);}}>
    <summary>{inventoryId ? '分析用の分類・商品種類・仕入ロットを修正' : '商品カテゴリー・商品種類・仕入ロットの設定'}</summary>
    {opened && <ManagementFields ports={ports} inventoryId={inventoryId}/>}
  </details>;
}

function ManagementFields({ports,inventoryId}:{ports:AnalysisManagementPorts;inventoryId?:string}) {
  const [view,setView] = useState<AnalysisMetadataView|null>(null);
  const [retry,setRetry] = useState(0);
  const [pending,setPending] = useState(true);
  const [status,setStatus] = useState('');
  const [saving,setSaving] = useState(false);
  useEffect(()=>{
    let active = true;
    void ports.read(inventoryId).then(result=>{
      if (!active) return;
      if (result.status==='ok') setView(result);
      else setStatus(result.status==='missing' ? '設定対象を確認できません。' : '分析設定を取得できませんでした。');
    },()=>{if(active)setStatus('分析設定を取得できませんでした。');}).finally(()=>{if(active)setPending(false);});
    return ()=>{active=false;};
  },[ports.read,inventoryId,retry]);

  async function save(request:AnalysisMetadataWrite) {
    setSaving(true);
    setStatus('');
    try {
      const result = await ports.save(request);
      if (result.status === 'ok') {
        setStatus('保存しました。次回の集計から反映されます。');
        setPending(true);
        setRetry(value=>value+1);
      } else setStatus(result.status === 'conflict' ? 'ほかの変更が保存されています。設定を再読み込みしてください。'
        : result.status === 'invalid' ? '入力した分類・識別子を確認してください。' : '変更を保存できませんでした。');
    } catch {
      setStatus('変更を保存できませんでした。');
    } finally {
      setSaving(false);
    }
  }

  return <div className="analysis-details my-3">
    {pending ? <p role="status">設定を読み込み中…</p> : view && (inventoryId
      ? <InventoryFields key={view.current?.revision??0} inventoryId={inventoryId} view={view} save={save} saving={saving}/>
      : <><TaxonomyFields key={view.taxonomyRevision} view={view} save={save} saving={saving}/><AnalysisMasters ports={ports} categories={view.categories}/></>)}
    {status && <p role="status">{status}</p>}
    {!pending && (!view || status.includes('再読み込み')) && <button type="button" className="analysis-button"
      onClick={()=>{setPending(true);setStatus('');setView(null);setRetry(value=>value+1);}}>設定を再読み込み</button>}
  </div>;
}

type SaveProps = {view:AnalysisMetadataView;saving:boolean;save:(request:AnalysisMetadataWrite)=>Promise<void>};

function TaxonomyFields({view,saving,save}:SaveProps) {
  const [selected,setSelected] = useState('');
  const [id,setId] = useState('');
  const [label,setLabel] = useState('');
  const [mergedInto,setMergedInto] = useState('');
  const categories = view.categories.filter(category=>category.id!=='__unknown__');
  function choose(category:ProductCategory|undefined) {
    setSelected(category?.id??'');setId(category?.id??'');setLabel(category?.label??'');setMergedInto(category?.mergedInto??'');
  }
  return <form className="analysis-details" onSubmit={event=>{
    event.preventDefault();
    if (saving || (!selected && categories.some(category=>category.id===id.trim()))) return;
    const value = {id:id.trim(),label:label.trim(),...(mergedInto ? {mergedInto} : {})};
    const list = selected ? categories.map(category=>category.id===selected ? value : category) : [...categories,value];
    void save({type:'taxonomy',value:{type:'taxonomy',categories:list},expectedRevision:view.taxonomyRevision});
  }}>
    <label className="analysis-field">設定するカテゴリー<select value={selected} onChange={event=>choose(categories.find(category=>category.id===event.target.value))}>
      <option value="">カテゴリーを追加</option>
      {categories.map(category=><option key={category.id} value={category.id}>{category.label}</option>)}
    </select></label>
    <label className="analysis-field">カテゴリーID<input required value={id} onChange={event=>setId(event.target.value)} maxLength={100} readOnly={Boolean(selected)} pattern="[A-Za-z0-9_\-]+"/></label>
    <label className="analysis-field">表示名<input required value={label} maxLength={100} onChange={event=>setLabel(event.target.value)}/></label>
    {selected && <label className="analysis-field">統合先<select value={mergedInto} onChange={event=>setMergedInto(event.target.value)}>
      <option value="">統合しない</option>
      {categories.filter(category=>category.id!==selected && !category.mergedInto).map(category=><option key={category.id} value={category.id}>{category.label}</option>)}
    </select></label>}
    <button type="submit" disabled={saving || (!selected && categories.some(category=>category.id===id.trim()))} className="analysis-button">カテゴリーを保存</button>
  </form>;
}

function InventoryFields({view,saving,save,inventoryId}:SaveProps & {inventoryId:string}) {
  const previous = view.current?.value.type==='inventory' ? view.current.value : null;
  const [categoryId,setCategoryId] = useState(previous?.categoryId??'');
  const [kindId,setKindId] = useState(previous?.kindId??'');
  const [lotId,setLotId] = useState(previous?.lotId??'');
  const [categoryState,setCategoryState] = useState(previous?.categoryState??'unknown');
  const [kindState,setKindState] = useState(previous?.kindState??'unknown');
  const [lotState,setLotState] = useState(previous?.lotState??'unknown');
  const state = (value:string,status:InventoryMetadata['kindState']) => value.trim() ? status : 'unknown';
  return <form className="analysis-details" onSubmit={event=>{
    event.preventDefault();
    if(saving) return;
    const value:InventoryMetadata = {
      type:'inventory',inventoryId,
      categoryId:categoryId || null,categoryState:state(categoryId,categoryState),
      kindId:kindId.trim() || null,kindState:state(kindId,kindState),
      lotId:lotId.trim() || null,lotState:state(lotId,lotState),
      salesQuantity:previous?.salesQuantity??null,salesQuantityEvidence:previous?.salesQuantityEvidence??null,
      retail:previous?.retail??'unknown',saleCostTotal:previous?.saleCostTotal??null,saleCostEvidence:previous?.saleCostEvidence??null,
    };
    void save({type:'inventory',value,expectedRevision:view.current?.revision??0});
  }}>
    <label className="analysis-field">商品カテゴリー<select value={categoryId} onChange={event=>{setCategoryId(event.target.value);setCategoryState(event.target.value ? 'confirmed' : 'unknown');}}>
      <option value="">未分類</option>
      {view.categories.filter(category=>category.id!=='__unknown__' && (!category.mergedInto || category.id===categoryId))
        .map(category=><option key={category.id} value={category.id}>{category.label}</option>)}
    </select></label>
    <ConfirmationField label="商品カテゴリーの確認状態" value={categoryState} change={setCategoryState}/>
    <label className="analysis-field">商品種類ID<input value={kindId} maxLength={150} onChange={event=>setKindId(event.target.value)}/></label>
    <ConfirmationField label="商品種類の確認状態" value={kindState} change={setKindState}/>
    <label className="analysis-field">仕入ロットID<input value={lotId} maxLength={150} onChange={event=>setLotId(event.target.value)}/></label>
    <ConfirmationField label="仕入ロットの確認状態" value={lotState} change={setLotState}/>
    <p className="analysis-note">照合した識別子は「確認済み」を選びます。識別子が空欄の項目は「判定不明」として保存します。</p>
    <button type="submit" disabled={saving} className="analysis-button">分類を保存</button>
  </form>;
}

function ConfirmationField({label,value,change}:{label:string;value:InventoryMetadata['kindState'];change:(value:InventoryMetadata['kindState'])=>void}) {
  return <label className="analysis-field">{label}<select value={value} onChange={event=>change(event.target.value as InventoryMetadata['kindState'])}>
    <option value="unknown">判定不明</option>
    <option value="candidate">候補</option>
    <option value="confirmed">確認済み</option>
  </select></label>;
}



