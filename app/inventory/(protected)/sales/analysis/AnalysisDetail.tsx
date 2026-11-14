'use client';

import Image from 'next/image';
import Link from 'next/link';
import {useEffect,useRef,useState} from 'react';
import {categoryBasisLabel,formatMetric,holdingBasisLabel,metricLabel,type AnalysisPorts,type DetailItem,type Metric,type ProductFact,type Slice} from '../../../../../lib/inventory/analysisUi/model';
import {AnalysisManagement} from './AnalysisManagement';
import type {AnalysisManagementPorts} from '../../../../../lib/inventory/analysisUi/management';
import {useDetail} from '../../../../../lib/inventory/analysisUi/useAnalysis';

export function AnalysisDetail({slice,drill,onClose,metric,productHref,management}:{
  slice:Slice; metric:Metric; drill:AnalysisPorts['drill']; onClose:()=>void; productHref?:(id:string)=>string; management?:AnalysisManagementPorts;
}) {
  const header = useRef<HTMLHeadingElement>(null);
  useEffect(()=>{header.current?.focus();},[]);
  return <section className="analysis-card analysis-detail" aria-labelledby="analysis-detail-title">
    <button type="button" className="analysis-button" onClick={onClose}>← グラフに戻る</button>
    <h2 id="analysis-detail-title" tabIndex={-1} ref={header}>{slice.label}の内訳</h2>
    <p className="analysis-note">{metricLabel(slice.request.target,metric)}{slice.request.start && slice.request.end ? ' · '+slice.request.start.replaceAll('-','/')+' ～ '+slice.request.end.replaceAll('-','/') : ''}</p>
    <DetailList slice={slice} drill={drill} productHref={productHref} management={management}/>
  </section>;
}

function DetailList({slice,drill,groupId,productHref,management}:{
  slice:Slice; drill:AnalysisPorts['drill']; groupId?:string; productHref?:(id:string)=>string; management?:AnalysisManagementPorts;
}) {
  const page = useDetail(drill,slice,groupId);
  return <div className="analysis-details">
    {page.items.map(item=><ProductCard key={item.type === 'group' ? 'group:'+item.group.kindId : 'record:'+item.record.id}
      item={item} slice={slice} drill={drill} productHref={productHref} management={management}/>)}
    {page.pending && <p role="status">内訳を読み込み中…</p>}
    {page.error && <div role="status">
      <p>{page.error === 'expired' ? 'この集計版の内訳は参照期限を過ぎました。グラフに戻って最新の集計を確認してください。' : page.error === 'missing' ? '集計データなし' : '内訳を取得できませんでした。'}</p>
      {page.error === 'error' && <button type="button" className="analysis-button" onClick={page.retry}>内訳を再試行</button>}
    </div>}
    {!page.pending && !page.error && page.items.length === 0 && <p role="status">対象データなし</p>}
    {page.more && !page.pending && !page.error && <button type="button" className="analysis-button" onClick={page.more}>さらに表示</button>}
  </div>;
}

function ProductCard({item,slice,drill,productHref,management}:{
  item:DetailItem; slice:Slice; drill:AnalysisPorts['drill']; productHref?:(id:string)=>string; management?:AnalysisManagementPorts;
}) {
  const [expanded,setExpanded] = useState(false);
  const group = item.type === 'group' ? item.group : null;
  const record = item.type === 'group' ? item.group.representative : item.record;
  const basis = slice.dimension === 'holdingCount'
    ? holdingBasisLabel(record.holdingBasis)
    : slice.dimension === 'category' ? categoryBasisLabel(record.categoryBasis) : undefined;
  return <article className="analysis-product">
    <div className="analysis-product-row">
      <ProductImage key={record.imageUrl || record.id} item={record}/>
      <div className="analysis-product-copy">
        <h3>{record.title}</h3>
        <p>{record.categoryLabel}{!group && record.date ? ' · '+record.date.replaceAll('-','/') : ''}</p>
        <p>{(group ? group.quantity : record.quantity) === null ? '数量未確認' : formatMetric((group ? group.quantity : record.quantity)!,'quantity')} · {(group ? group.amount : record.amount) === null ? (slice.request.target === 'sales' ? '売上未確認' : '原価未登録') : formatMetric((group ? group.amount : record.amount)!,'amount')}</p>
        {basis && <p>{basis}</p>}
        {group ? <button type="button" className="analysis-button" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>
          {expanded ? '構成レコードを閉じる' : '構成レコードを表示（'+group.count+'件）'}
        </button> : productHref && record.inventoryId && <Link className="analysis-button" href={productHref(record.inventoryId)} prefetch={false}>商品詳細</Link>}
      </div>
    </div>
    {!group && management && record.inventoryId && <AnalysisManagement ports={management} inventoryId={record.inventoryId}/>}
    {group && expanded && <DetailList groupId={group.kindId} slice={slice} drill={drill} productHref={productHref} management={management}/>}
  </article>;
}

function ProductImage({item}:{item:ProductFact}) {
  const [failed,setFailed] = useState(false);
  return item.imageUrl && !failed
    ? <Image className="analysis-product-image" alt="" src={item.imageUrl} width={88} height={88} unoptimized onError={()=>setFailed(true)}/>
    : <span className="analysis-product-image">{item.imageRef ? '画像を表示できません' : '画像なし'}</span>;
}


