'use client';

import {useState,type FormEvent} from 'react';
import type {AcquisitionLot,Confirmation,MetadataRow,ProductCategory,ProductKind} from '../../../../../lib/inventory/analysis/types';
import {sourceKey} from '../../../../../lib/inventory/analysis/normalize';
import type {AnalysisManagementPorts,AnalysisMetadataWrite} from '../../../../../lib/inventory/analysisUi/management';

type MasterType = 'kind'|'lot';
const masterLabel = {kind:'商品種類',lot:'仕入ロット'};
type MasterValue = ProductKind|AcquisitionLot;

export function AnalysisMasters({ports,categories}:{ports:AnalysisManagementPorts;categories:ProductCategory[]}) {
  const [type,setType] = useState<MasterType|null>(null);
  return <div className="analysis-details">
    <div className="analysis-choices" aria-label="管理する項目">
      {(Object.keys(masterLabel) as MasterType[]).map(option=><button key={option} type="button" className="analysis-choice"
        aria-pressed={type===option} onClick={()=>setType(previous=>previous===option?null:option)}>{masterLabel[option]}を管理</button>)}
    </div>
    {type && <MasterPanel key={type} type={type} ports={ports} categories={categories}/>}
  </div>;
}

function MasterPanel({type,ports,categories}:{type:MasterType;ports:AnalysisManagementPorts;categories:ProductCategory[]}) {
  const [rows,setRows] = useState<MetadataRow[]>([]);
  const [cursor,setCursor] = useState<string|null>(null);
  const [selected,setSelected] = useState<MetadataRow|null|undefined>(undefined);
  const [status,setStatus] = useState('');
  const [busy,setBusy] = useState(false);

  async function load(append=false) {
    setBusy(true);
    if (!append) setSelected(undefined);
    try {
      const result = await ports.list({type,cursor:append && cursor ? cursor : undefined});
      if (result.status!=='ok') throw new Error();
      setRows(previous=>append ? [...previous,...result.rows] : result.rows);
      setCursor(result.nextCursor);
    } catch {
      setStatus('設定を取得できませんでした。');
    } finally {
      setBusy(false);
    }
  }

  async function save(value:MasterValue) {
    if (busy) return;
    setBusy(true);
    setStatus('');
    try {
      const expectedRevision = selected?.revision ?? 0;
      const request:AnalysisMetadataWrite = value.type==='kind' ? {type:'kind',value,expectedRevision} : {type:'lot',value,expectedRevision};
      const result = await ports.save(request);
      setStatus(result.status==='ok' ? '保存しました。次回の集計から反映されます。'
        : result.status==='conflict' ? 'ほかの変更が保存されています。設定を再読み込みしてください。'
        : result.status==='invalid' ? '入力した項目をご確認ください。' : '変更を保存できませんでした。');
      if (result.status==='ok') {
        setSelected(undefined);
        await load();
      }
    } catch {
      setStatus('変更を保存できませんでした。');
    } finally {
      setBusy(false);
    }
  }

  const original = selected?.value;
  return <section className="analysis-card analysis-details" aria-label={masterLabel[type]+'の管理'}>
    <h3>{masterLabel[type]}の管理</h3>
    <div className="analysis-choices">
      <button type="button" className="analysis-button" disabled={busy} onClick={()=>void load()}>一覧を読み込む</button>
      <button type="button" className="analysis-button" disabled={busy} onClick={()=>setSelected(null)}>{masterLabel[type]}を追加</button>
    </div>
    {rows.length>0 && <ul>{rows.map(row=><li key={row.id}><button type="button" className="analysis-button"
      disabled={busy} onClick={()=>setSelected(row)}>{row.value.type==='kind' ? [row.value.specification.brand,row.value.specification.model,row.value.id].filter(Boolean).join(' · ')
      : row.value.type==='lot' ? row.value.date+' · '+row.value.id : row.id}</button></li>)}</ul>}
    {cursor && <button type="button" className="analysis-button" disabled={busy} onClick={()=>void load(true)}>さらに表示</button>}
    {selected!==undefined && <MasterForm key={selected?.id??'new'} type={type} categories={categories}
      original={original?.type==='kind'||original?.type==='lot' ? original : undefined} save={save} busy={busy}/>}
    {status && <p role="status">{status}</p>}
  </section>;
}

const specificationFields = [
  ['brand','ブランド'],['model','モデル'],['color','色'],['material','張地・素材'],['size','サイズ'],['saleUnit','販売単位'],
] as const;
function MasterForm({type,original,categories,save,busy}:{
  type:MasterType;original?:MasterValue;categories:ProductCategory[];save:(value:MasterValue)=>Promise<void>;busy:boolean;
}) {
  const kind = original?.type==='kind' ? original : null;
  const lot = original?.type==='lot' ? original : null;
  const [operation,setOperation] = useState<AcquisitionLot['operation']>(lot?.operation??'acquisition');

  function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const get = (key:string) => String(form.get(key)??'').trim();
    const optionalNumber = (key:string) => get(key) ? Number(get(key)) : null;
    const state = get('state') as Confirmation;
    const categoryId = get('categoryId') || null;
    if (type==='kind') {
      const specification = Object.fromEntries(specificationFields.map(([key])=>[key,get(key)])) as ProductKind['specification'];
      void save({type,id:get('id'),state,categoryId,modelId:get('modelId')||null,specification});
    } else {
      const source = get('source');
      const sourceRecordId = get('line');
      void save({
        type,id:sourceKey(source,sourceRecordId),source,sourceRecordId,state,categoryId,operation,
        date:get('date'),quantity:optionalNumber('quantity'),costTotal:optionalNumber('costTotal'),
        kindId:get('kindId')||null,merchandise:form.get('merchandise')==='on',originalLotId:operation==='acquisition' ? null : get('originalLotId') || null,
      });
    }
  }

  return <form className="analysis-details" onSubmit={submit}>
    {type==='kind' ? <>
      <label className="analysis-field">商品種類ID<input name="id" required readOnly={Boolean(kind)} defaultValue={kind?.id} maxLength={150}/></label>
      <label className="analysis-field">モデルID<input name="modelId" defaultValue={kind?.modelId??''} maxLength={150}/></label>
      {specificationFields.map(([key,label])=><label className="analysis-field" key={key}>{label}
        <input name={key} defaultValue={kind?.specification[key]} maxLength={150}/>
      </label>)}
    </> : <>
      <label className="analysis-field">仕入元<input name="source" required readOnly={Boolean(lot)} defaultValue={lot?.source} maxLength={100}/></label>
      <label className="analysis-field">元明細ID<input name="line" required readOnly={Boolean(lot)} defaultValue={lot?.sourceRecordId} maxLength={150}/></label>
      <label className="analysis-field">取引日<input name="date" type="date" required defaultValue={lot?.date} min="2026-01-01"/></label>
      <label className="analysis-field">仕入数量<input name="quantity" type="number" min="0" step="1" defaultValue={lot?.quantity??''}/></label>
      <label className="analysis-field">仕入原価総額（円）<input name="costTotal" type="number" min="0" step="1" defaultValue={lot?.costTotal??''}/></label>
      <label className="analysis-field">商品種類ID<input name="kindId" defaultValue={lot?.kindId??''} maxLength={150}/></label>
      <label className="analysis-field">取引区分<select value={operation} onChange={event=>setOperation(event.target.value as AcquisitionLot['operation'])}>
        <option value="acquisition">仕入れ</option><option value="return">返品</option><option value="cancellation">取消</option>
      </select></label>
      {operation!=='acquisition' && <label className="analysis-field">返品・取消の元ロットID<input name="originalLotId" required defaultValue={lot?.originalLotId??''} maxLength={256}/></label>}
      <label><input type="checkbox" name="merchandise" defaultChecked={lot?.merchandise??true}/> 販売用の商品</label>
    </>}
    <label className="analysis-field">商品カテゴリー<select name="categoryId" defaultValue={original?.categoryId??''}>
      <option value="">未分類</option>{categories.filter(category=>!category.mergedInto&&category.id!=='__unknown__').map(category=><option value={category.id} key={category.id}>{category.label}</option>)}
    </select></label>
    <label className="analysis-field">確認状態<select name="state" defaultValue={original?.state??'candidate'}>
      <option value="candidate">候補</option><option value="confirmed">確認済み</option><option value="unknown">判定不明</option>
    </select></label>
    <button className="analysis-button" type="submit" disabled={busy}>{masterLabel[type]}を保存</button>
  </form>;
}

