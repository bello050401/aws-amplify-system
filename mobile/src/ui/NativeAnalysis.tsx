import React,{useState} from 'react';
import {ActivityIndicator,Image,Pressable,StyleSheet,Text,useWindowDimensions,View} from 'react-native';
import Svg,{Circle,Path,Text as SvgText} from 'react-native-svg';
import {formatJstDateTime} from '../../../lib/inventory/sales';
import {
  analysisRequest,inventoryComparisonRequest,arcPath,categoryBasisLabel,chartBasis,chartContent,detailItemKey,detailMetricFor,displayRows,formatMetric,graphSegments,groupingFor,holdingBasisLabel,skuHoldingNote,inventoryCompositionNote,jstDay,metricFor,metricLabel,
  unknownAmount,type AnalysisResult,type AnalysisRequest,type AnalysisPorts,type AnalysisState,type Bucket,type DetailGroup,type DetailItem,type Dimension,type DisplayRow,type Metric,type ProductFact,type Slice,type Target,
} from '../../../lib/inventory/analysisUi/model';
import {comparisonRows,signedChange,formatPercentagePointDelta,inventoryHistorySummary,comparisonBuckets} from '../../../lib/inventory/analysisUi/comparison';
import {useAnalysis,useDetail} from '../../../lib/inventory/analysisUi/useAnalysis';

export interface NativeAnalysisProps {
  state:AnalysisState;
  change:(change:Partial<AnalysisState>)=>void;
  ports?:AnalysisPorts;
  offline:boolean;
  today?:string;
  inventoryRead?:ReturnType<typeof useAnalysis>;
  onOpen:(id:string)=>void;
}

const button = (label:string,press:()=>void,selected?:boolean) =>
  <Pressable accessibilityRole="button" accessibilityState={selected === undefined ? undefined : {selected}}
    onPress={press} style={[s.button,selected&&s.active]}><Text style={[s.buttonText,selected&&s.activeText]}>{label}</Text></Pressable>;

export function NativeAnalysis({state,change,ports,offline,onOpen,today=jstDay(),inventoryRead}:NativeAnalysisProps) {
  const skuTab = state.tab === 'breakdown';
  const request = analysisRequest(skuTab ? {...state,breakdown:'inventory'} : state,today);
  const metric = skuTab ? 'skus' : metricFor(state);
  const {key,detailed} = groupingFor(state);
  const read = useAnalysis(ports?.load,inventoryRead || state.slice ? null : request,!offline);
  const api = inventoryRead ?? read;
  const acquisition = state.tab === 'breakdown' && state.breakdown === 'acquisitions';
  const acquisitionRequest = {target:'acquisitions'} as const;
  const purchase = useAnalysis(ports?.load,acquisition && !state.slice ? acquisitionRequest : null,!offline);
  const purchaseGeneration = purchase.data?.status === 'ok' ? purchase.data.metadata.generation : null;
  const compare = acquisition && state.acquisitionUnit === 'amount' && !!purchaseGeneration;
  const reference = useAnalysis(ports?.load,state.reference && compare && purchaseGeneration ? {target:'retailReference',generation:purchaseGeneration} : null,!offline);
  const comparing = request?.target === 'inventory' && (state.inventoryCompareWeeks > 0 || Boolean(state.inventoryCompareDay));
  const anchor = api.data;
  const weeksRequest = inventoryComparisonRequest(anchor?.status==='ok' ? anchor.metadata.asOf : today+'T00:00:00+09:00',state.inventoryCompareWeeks || 2);
  const historicalRequest = state.inventoryCompareDay ? {target:'inventory' as const,daily:state.inventoryCompareDay} : weeksRequest;
  const comparisonDay = historicalRequest.daily!;
  const availableDays = anchor?.status==='ok' ? (anchor.metadata.inventoryHistoryAvailableDays??[]).filter(day=>day < anchor.metadata.coverageEnd).sort().reverse() : [];
  const [showAvailableDays,setShowAvailableDays]=useState(false);
  const historical = useAnalysis(ports?.load,comparing && anchor?.status==='ok' && !state.slice ? historicalRequest : null,!offline);
  const comparisonWide = useWindowDimensions().width >= 1000;
  const [showSkuNotes,setShowSkuNotes] = useState(false);
  if (state.slice) {
    const slice = state.slice;
    return <View style={s.section}>{button('← グラフに戻る',()=>change({slice:null}))}
      <Text accessibilityRole="header" style={s.heading}>{slice.label}の内訳</Text>
      {slice.request.daily && <Text style={s.note}>{slice.request.daily.replace(/-/g,'/')}時点の内訳</Text>}
      <Text style={s.note}>{metricLabel(slice.request.target,detailMetricFor(slice,state))}{slice.request.start && slice.request.end ? ' · '+slice.request.start.replace(/-/g,'/')+' ～ '+slice.request.end.replace(/-/g,'/') : ''}</Text>
      {offline ? <Text style={s.note}>通信できる状態で内訳を確認してください。</Text> : <NativeDetails key={slice.request.generation+':'+slice.dimension+':'+slice.key} slice={slice} drill={ports?.drill} onOpen={onOpen}/>}
    </View>;
  }
  function renderResult({data,retry}:ReturnType<typeof useAnalysis>, selected:Metric, selection:AnalysisRequest, isHistorical=false,onlyDimension?:Dimension,showNotes=true) {
    if (!data) return <ActivityIndicator accessibilityLabel="集計を読み込み中"/>;
    if (data.status !== 'ok') return <View style={s.card}>
      <Text accessibilityRole="alert" style={s.note}>{data.status==='missing' ? isHistorical ? 'この日の在庫データはありません。' : '集計データなし' : data.status==='expired' ? 'この集計版は参照期限を過ぎました。' : '集計を取得できませんでした。'}</Text>
      {data.status!=='missing' && button('集計を再試行',retry)}
    </View>;
    const {summary,target,period,metadata} = data;
    const counterpart = isHistorical ? api.data : historical.data;
    if (selected === 'skus' && summary.skus === undefined) return <Text style={s.note}>この時点のSKU内訳の記録はありません。</Text>;
    const isReference = target === 'retailReference';
    const {gross,total,returned,net} = chartBasis(summary,selected);
    const inventory = target === 'inventory';
    const label = isReference ? '直近90日の小売実績' : target === 'sales' ? '選択期間の売上' : target === 'acquisitions' ? '直近30日の仕入れ' : '現在庫';
    const missingAmount = unknownAmount(summary,target);
    const unknown = summary.records > 0 && missingAmount >= summary.records;
    const unknownList = [
      ...(target==='sales' ? [['売上金額未登録',missingAmount] as const] : []),
      ['原価未登録',summary.unknown.cost],['数量未確認',summary.unknown.quantity],['未分類',summary.unknown.category],
      ['種類未判定',summary.unknown.kind],['ロット未判定',summary.unknown.lot],
    ] as const;
    return <View style={s.section}>
      {selected === 'skus' && <View>
        {!comparing && <Text accessibilityRole="header" style={s.heading}>{isHistorical || selection.daily ? 'この時点のSKU' : '現在庫のSKU'}</Text>}
        <Text style={s.total}>{formatMetric(total,'skus')}</Text>
        <Text style={s.note}>{formatJstDateTime(metadata.asOf)} JST 時点</Text>
      </View>}
      {!inventory && <View style={[s.card,s.summary]}>
        <Text accessibilityRole="header" style={s.heading}>{label}</Text>
        <Text style={s.total}>{unknown ? '—' : formatMetric(summary.amount,'amount')}</Text>
        {target === 'acquisitions' && <>
          <Text style={s.note}>確認できた仕入数量 {formatMetric(summary.quantity,'quantity')} · {formatMetric(summary.lots,'lots')}</Text>
          <Text style={s.note}>商品として仕入れた分を集計しています。販売済み・業販予定分を含みます。{metadata.unlocatedAcquisitionRecords > 0 && ' 仕入日や元明細を確認できない記録 '+metadata.unlocatedAcquisitionRecords+'件。'}</Text>
        </>}
        {period && <Text style={s.note}>{period.start.replace(/-/g,'/')} ～ {period.end.replace(/-/g,'/')}{period.partial ? '（途中）' : ''}</Text>}
        <Text style={s.note}>{formatJstDateTime(metadata.asOf)} JST 時点</Text>
        <Text style={s.note}>{metadata.amountBasis}</Text>
        {unknownList.some(([,count])=>count>0) && <Text style={s.note}>{unknownList.filter(([,count])=>count>0).map(([name,count])=>name+' '+count+'件').join(' · ')}</Text>}
        {gross && <Text style={s.note}>円グラフは返品前の構成です。返品・取消 {formatMetric(returned,selected)} · 差引 {formatMetric(net,selected)}</Text>}
        {isReference && <Text style={s.note}>確認済みの小売実績の参考配分。販路未確認 {data.referenceExclusions.unknownChannel}件 · 原価未確認 {data.referenceExclusions.unknownCost}件 · 取得元未確認 {data.referenceExclusions.unverifiedOrigin}件 · その他の対象外 {data.referenceExclusions.excluded}件（対象外の売上 {formatMetric(data.referenceExclusions.salesAmount,'amount')}）</Text>}
      </View>}
      {!inventory && !isReference && button(detailed ? '単品・複数に戻す' : '数量帯を詳しく',()=>change({detailed:{...state.detailed,[key]:!detailed}}),detailed)}
      {chartContent(target,selected,detailed).filter(chart=>!onlyDimension || chart.dimension===onlyDimension).map(({title,dimension})=><NativeDonut
        comparison={comparing} key={metadata.generation+':'+target+':'+selected+':'+dimension} title={title} target={target} metric={selected} dimension={dimension}
        note={dimension === 'skuHoldingCount' ? skuHoldingNote : inventory ? '商品名による分類を含みます。' : undefined}
        denominator={inventory && selected === 'amount' ? inventoryCompositionNote(selected) : undefined}
        buckets={comparing && counterpart?.status==='ok' ? comparisonBuckets(summary.dimensions[dimension]??[],counterpart.summary.dimensions[dimension]??[],dimension,isHistorical ? counterpart.summary.dimensions[dimension]??[] : summary.dimensions[dimension]??[]) : summary.dimensions[dimension]??[]} total={total} gross={gross} records={summary.records} unknown={unknown && selected==='amount'}
        select={row=>change({slice:{dimension,key:row.key,label:row.label,request:{...selection,generation:metadata.generation}}})}
      />)}
      {selected === 'skus' && showNotes && <View style={s.section}>
        <Pressable accessibilityRole="button" aria-expanded={showSkuNotes} accessibilityState={{expanded:showSkuNotes}} onPress={()=>setShowSkuNotes(value=>!value)} style={s.button}>
          <Text style={s.buttonText}>SKUの集計方法</Text>
        </Pressable>
        {showSkuNotes && <View>
          <Text style={s.note}>管理SKUごとに1 SKUとして集計します。</Text>
          {(summary.unknownSkuRecords ?? 0) > 0 && <Text style={s.note}>管理SKUが未登録の在庫 {summary.unknownSkuRecords?.toLocaleString('ja-JP')}件は集計の対象外です。</Text>}
        </View>}
      </View>}
    </View>;
  }

  if (offline) return <Text style={s.note}>通信できる状態で集計を確認してください。</Text>;
  return <View style={s.section}>
    {request?.target === 'inventory' && <View style={s.section}>
      <Choices label="在庫の比較期間" value={state.inventoryCompareDay ? 'date' : String(state.inventoryCompareWeeks)} options={[{key:'0',label:'現在のみ'},{key:'2',label:'2週間前'},{key:'3',label:'3週間前'},{key:'4',label:'4週間前'}] as const} select={weeks=>change({inventoryCompareWeeks:Number(weeks) as 0|2|3|4,inventoryCompareDay:''})}/>
      {availableDays.length>0 && <View style={s.section}>{button('記録のある日から選ぶ',()=>setShowAvailableDays(value=>!value))}{showAvailableDays && <Choices label="記録のある比較日" value={state.inventoryCompareDay??''} options={availableDays.map(day=>({key:day,label:day.replace(/-/g,'/')}))} select={day=>{change({inventoryCompareDay:day,inventoryCompareWeeks:0});setShowAvailableDays(false);}}/>}</View>}
    </View>}
    {comparing && api.data?.status==='ok' && historical.data?.status==='ok' && (metric!=='skus' || historical.data.summary.skus!==undefined && api.data.summary.skus!==undefined) ? <NativeComparison current={api.data} prior={historical.data} currentRequest={request!} priorRequest={historicalRequest} metric={metric} detailed={detailed} select={slice=>change({slice})}/> : comparing ? <>
      <View style={s.card} accessibilityLabel="過去の在庫の比較状況">
        <Text accessibilityRole="header" style={s.heading}>{state.inventoryCompareDay ? '指定日' : state.inventoryCompareWeeks+'週間前'} · {comparisonDay.replace(/-/g,'/')}</Text>
        <Text accessibilityRole="alert" style={s.note}>{anchor?.status!=='ok' ? '基準の在庫データを取得すると比較できます。' : !historical.data ? '過去の在庫を読み込み中…' : historical.data.status==='ok' ? 'この時点のSKU内訳の記録はありません。' : historical.data.status==='missing' ? 'この日の在庫データはありません。記録のある日を選んでください。' : historical.data.status==='expired' ? 'この集計版は参照期限を過ぎました。' : '集計を取得できませんでした。'}</Text>
        {historical.data && ['error','expired'].includes(historical.data.status) && button('集計を再試行',historical.retry)}
      </View>
      {request && renderResult(api,metric,request)}
    </> : request && renderResult(api,metric,request)}
    {skuTab && <View style={s.section}>
      <Pressable accessibilityRole="button" aria-expanded={acquisition} accessibilityState={{expanded:acquisition}} onPress={()=>change({breakdown:acquisition?'inventory':'acquisitions'})} style={s.button}>
        <Text style={s.buttonText}>直近30日の仕入れ</Text>
      </Pressable>
      {acquisition && <>
        <Choices label="仕入れの集計単位" value={state.acquisitionUnit} options={[{key:'amount',label:'仕入原価'},{key:'quantity',label:'仕入数量'},{key:'lots',label:'仕入ロット数'}] as const} select={acquisitionUnit=>change({acquisitionUnit})}/>
        {renderResult(purchase,state.acquisitionUnit,acquisitionRequest)}
        {compare && <>
          {button('小売実績の参考配分と比較',()=>change({reference:!state.reference}),state.reference)}
          {state.reference && renderResult(reference,'amount',{target:'retailReference'})}
        </>}
      </>}
    </View>}
  </View>;
}

type ComparisonCapture=Extract<AnalysisResult,{status:'ok'}>;
function NativeComparison({current,prior,currentRequest,priorRequest,metric,detailed,select}:{current:ComparisonCapture;prior:ComparisonCapture;currentRequest:AnalysisRequest;priorRequest:AnalysisRequest;metric:Metric;detailed:boolean;select:(slice:Slice)=>void}) {
  const day=(capture:ComparisonCapture)=>capture.metadata.coverageEnd.replace(/-/g,'/');
  const [showHistory,setShowHistory]=useState(false);
  return <View style={s.section}>
    <Text style={s.note}>過去 {day(prior)} → 現在 {day(current)}</Text>
    {prior.metadata.inventoryHistory && <View style={s.section}>{button('過去は復元データ',()=>setShowHistory(value=>!value))}{showHistory && <Text style={s.note}>当時の記録から在庫を復元しています。{inventoryHistorySummary(prior.metadata.inventoryHistory)} {prior.metadata.inventoryHistory.limitations.join(' ')}</Text>}</View>}
    {chartContent('inventory',metric,detailed).map(({title,dimension})=>{
      const rows=comparisonRows(current.summary.dimensions[dimension]??[],prior.summary.dimensions[dimension]??[],dimension,metric);
      const open=(period:'prior'|'current',key:string,label:string)=>select({dimension,key,label,request:{...(period==='prior'?priorRequest:currentRequest),generation:(period==='prior'?prior:current).metadata.generation}});
      const known=(capture:ComparisonCapture)=>metric!=='amount'||capture.summary.records===0||unknownAmount(capture.summary,'inventory')<capture.summary.records;
      const delta=known(current)&&known(prior)?chartBasis(current.summary,metric).total-chartBasis(prior.summary,metric).total:null;
      return <View key={dimension} style={s.card} accessibilityLabel={title+'の比較'}>
        <Text accessibilityRole="header" style={s.heading}>{title}</Text>
        <View style={s.pairedRings}>{(['prior','current'] as const).map(period=>{
          const capture=period==='prior'?prior:current;
          return <View key={period} style={s.pairedPeriod}>
            <Text style={s.pairedTitle}>{period==='prior'?'過去':'現在'}</Text><Text style={s.pairedDate}>{formatJstDateTime(capture.metadata.asOf)} JST</Text>
            <View style={s.pairedDonut}><Svg width="100%" height="100%" viewBox="0 0 220 220">
              <Circle cx={110} cy={110} r={88} fill="none" stroke="#e9eeeb" strokeWidth={24}/>
              {graphSegments(rows.map(row=>row[period])).map(segment=><Path key={segment.key} d={arcPath(segment.percent,segment.offset,88)} stroke={segment.color} fill="none" strokeWidth={24} onPress={()=>open(period,segment.key,segment.label)}/>)}
              <SvgText x={110} y={103} textAnchor="middle" fill="#526359" fontSize={14}>{metric==='skus'?'SKU数':'在庫金額'}</SvgText>
              <SvgText x={110} y={127} textAnchor="middle" fill="#214d41" fontSize={19} fontWeight="700">{known(capture)?formatMetric(chartBasis(capture.summary,metric).total,metric):'—'}</SvgText>
            </Svg></View>
          </View>;
        })}</View>
        <Text style={s.pairedTitle}>合計の増減 {signedChange(delta,value=>formatMetric(value,metric))}</Text>
        <View style={s.pairedNumbers}>{['過去','現在','増減'].map(label=><Text key={label} style={[s.pairedCell,s.pairedDate]}>{label}</Text>)}</View>
        {rows.map(row=><View key={row.key} style={s.pairedRow}>
          <View style={s.pairedLabel}><View style={[s.dot,{backgroundColor:row.color}]}/><Text style={s.label}>{row.label}</Text></View>
          <View style={s.pairedNumbers}>{(['prior','current'] as const).map(period=><Pressable key={period} accessibilityRole="button" accessibilityLabel={(period==='prior'?'過去':'現在')+'の'+row.label+' '+(row[period].unknownValue?'金額未確認':formatMetric(row[period].value,metric))+'の内訳を開く'} style={[s.pairedCell,s.pairedButton]} onPress={()=>open(period,row.key,row.label)}>
            <Text style={s.pairedValue}>{row[period].unknownValue?'—':formatMetric(row[period].value,metric)}</Text><Text style={s.pairedDate}>{row[period].unknownValue?'未確認':row[period].percent.toFixed(1)+'%'}</Text>
          </Pressable>)}<View style={s.pairedCell}><Text style={[s.pairedValue,row.change!==null&&row.change<0&&s.decrease]}>{signedChange(row.change,value=>formatMetric(value,metric))}</Text><Text style={s.pairedDate}>{formatPercentagePointDelta(row.points)}</Text></View></View>
        </View>)}
        {(current.summary.unknown.cost>0 || prior.summary.unknown.cost>0) && metric==='amount' && <Text style={s.note}>確認できた原価で比較しています。原価未登録：過去 {prior.summary.unknown.cost}件・現在 {current.summary.unknown.cost}件。</Text>}
        {metric==='skus' && ((current.summary.unknownSkuRecords??0)>0 || (prior.summary.unknownSkuRecords??0)>0) && <Text style={s.note}>管理SKU未登録のため対象外：過去 {prior.summary.unknownSkuRecords??0}件・現在 {current.summary.unknownSkuRecords??0}件。</Text>}
        <Text style={s.note}>{dimension==='skuHoldingCount'?skuHoldingNote:metric==='amount'?inventoryCompositionNote(metric):'管理SKUごとに1 SKUとして集計します。'} 増減は現在−過去、ptは構成比の差です。</Text>
      </View>;
    })}
  </View>;
}

function Choices<K extends string>({label,value,options,select}:{
  label:string; value:K; options:readonly {key:K;label:string}[]; select:(key:K)=>void;
}) {
  return <View accessibilityLabel={label} style={s.controls}>{options.map(option=><React.Fragment key={option.key}>
    {button(option.label,()=>select(option.key),value===option.key)}
  </React.Fragment>)}</View>;
}

function NativeDonut({title,target,metric,dimension,buckets,total,gross,records,unknown,note,denominator,select,comparison=false}:{
  title:string; target:Target; metric:Metric; dimension:Dimension; buckets:Bucket[]; total:number; gross:boolean; records:number;
  unknown:boolean; comparison?:boolean; note?:string; denominator?:string; select:(row:DisplayRow)=>void;
}) {
  const [showAll,setShowAll] = useState(false);
  const [other,setOther] = useState<DisplayRow[]|null>(null);
  const viewport = useWindowDimensions().width;
  const wide = viewport >= 700 && !(comparison && viewport >= 1000);
  const {rows,expandable} = displayRows(buckets,metric,gross,showAll || comparison,dimension==='category' || dimension==='skuCategory',target,dimension);
  const label = metricLabel(target,metric)+(gross ? '（返品前）' : '');
  const radius = 88;
  function open(row:DisplayRow) {
    if (row.categories) setOther(previous=>previous ? null : row.categories!);
    else select(row);
  }
  return <View style={s.card}>
    <Text accessibilityRole="header" style={s.heading}>{title}</Text>
    {note && <Text style={s.note}>{note}</Text>}
    <View style={[s.chartBody,wide && s.chartWide]}>
      <View style={[s.donut,wide && s.donutWide]}>
        <Svg width="100%" height="100%" viewBox="0 0 220 220">
          <Circle cx={110} cy={110} r={radius} fill="none" stroke="#e9eeeb" strokeWidth={24}/>
          {graphSegments(rows).map(segment=><Path key={segment.key} d={arcPath(segment.percent,segment.offset,radius)} stroke={segment.color} fill="none" strokeWidth={24} onPress={()=>open(segment)}
          />)}
          <SvgText x={110} y={102} textAnchor="middle" fill="#526359" fontSize={12}>{label}</SvgText>
          <SvgText x={110} y={126} textAnchor="middle" fill="#214d41" fontSize={21} fontWeight="700">{unknown?'—':formatMetric(total,metric)}</SvgText>
        </Svg>
      </View>
      <View style={s.grow}>
      {records === 0 ? <Text style={s.note}>対象データなし</Text> : unknown ? <Text style={s.note}>{target === 'sales' ? '売上金額' : '原価'}未登録のため金額割合を表示できません。</Text> : total===0 && <Text style={s.note}>構成比を表示できる{label}がありません。</Text>}
      {rows.map(row=><Pressable key={row.key} accessibilityRole="button"
        accessibilityState={row.categories ? {expanded:Boolean(other)} : undefined} onPress={()=>open(row)} style={s.legend}>
        <View style={[s.dot,{backgroundColor:row.color}]}/>
        <View style={s.grow}>
          <Text style={s.label}>{row.label}</Text>
          {row.quantity !== undefined && <Text style={s.note}>{formatMetric(row.quantity,'quantity')}</Text>}
        </View>
        <Text style={s.value}>{row.unknownValue ? '—' : formatMetric(row.value,metric)}</Text>
        <Text style={[s.note,s.percent]}>{total>0 && !row.unknownValue ? row.percent.toFixed(1)+'%' : '—'}</Text>
      </Pressable>)}
      {other && !showAll && <View style={s.controls}>{other.map(row=><React.Fragment key={row.key}>{button(row.label,()=>select(row))}</React.Fragment>)}</View>}
      </View>
    </View>
    {denominator && <Text style={s.note}>{denominator}</Text>}
    {expandable && button(showAll?'上位カテゴリーに戻す':'すべて見る',()=>{setOther(null);setShowAll(value=>!value);})}
  </View>;
}

function NativeDetails({slice,drill,onOpen,group}:{slice:Slice; drill:AnalysisPorts['drill']|undefined; onOpen:(id:string)=>void; group?:DetailGroup}) {
  const page = useDetail(drill,slice,group);
  return <View style={s.section}>
    {page.items.map(item=>item.type!=='record'
      ? <NativeGroup key={detailItemKey(item)} item={item} slice={slice} drill={drill} onOpen={onOpen}/>
      : <NativeProduct key={detailItemKey(item)} record={item.record} amount={item.record.amount} quantity={item.record.quantity}
          action={item.record.inventoryId ? button('商品詳細',()=>onOpen(item.record.inventoryId!)) : undefined} date={item.record.date} sales={slice.request.target==='sales'} dimension={slice.dimension}/>)}
    {page.pending && <ActivityIndicator accessibilityLabel="内訳を読み込み中"/>}
    {page.error && <View style={s.section}><Text accessibilityRole="alert" style={s.note}>
      {page.error==='expired' ? 'この集計版の内訳は参照期限を過ぎました。グラフに戻って最新の集計を確認してください。' : page.error==='missing' ? '集計データなし' : '内訳を取得できませんでした。'}
    </Text>{page.error==='error' && button('内訳を再試行',page.retry)}</View>}
    {!page.pending && !page.error && page.items.length===0 && <Text style={s.note}>対象データなし</Text>}
    {page.more && !page.pending && !page.error && button('さらに表示',page.more)}
  </View>;
}

function NativeGroup({slice,drill,onOpen,item}:{slice:Slice;drill:AnalysisPorts['drill']|undefined;onOpen:(id:string)=>void;item:Exclude<DetailItem,{type:'record'}>}) {
  const [open,setOpen] = useState(false);
  const {group} = item;
  const groupRef = item.type==='sku-group' ? {groupSku:item.group.groupKey} : {groupKindId:item.group.kindId};
  return <View style={s.section}>
    <NativeProduct record={group.representative} amount={group.amount} quantity={group.quantity}
      action={button(open?'構成レコードを閉じる':'構成レコードを表示（'+group.count+'件）',()=>setOpen(value=>!value),open)}
      sales={slice.request.target==='sales'} dimension={slice.dimension}/>
    {open && <View style={{marginLeft:10}}><NativeDetails slice={slice} drill={drill} onOpen={onOpen} group={groupRef}/></View>}
  </View>;
}

function NativeProduct({record,amount,quantity,action,date,sales,dimension}:{
  record:ProductFact; amount:number|null; quantity:number|null; action?:React.ReactNode; date?:string|null; sales:boolean; dimension:Dimension;
}) {
  const [failed,setFailed] = useState(false);
  const skuDetail = dimension === 'skuCategory' || dimension === 'skuHoldingCount';
  const basis = dimension === 'holdingCount'
    ? holdingBasisLabel(record.holdingBasis)
    : dimension === 'category' ? categoryBasisLabel(record.categoryBasis) : undefined;
  return <View style={[s.card,s.product]}>
    {record.imageUrl && !failed
      ? <Image source={{uri:record.imageUrl}} style={s.image} onError={()=>setFailed(true)}/>
      : <View style={s.image}><Text style={s.imageText}>{record.imageRef ? '画像を表示できません' : '画像なし'}</Text></View>}
    <View style={s.grow}>
      <Text accessibilityRole="header" style={s.heading}>{record.title}</Text>
      {record.sku && <Text style={s.productSku}>管理SKU {record.sku}</Text>}
      <Text style={s.note}>{record.categoryLabel}{!skuDetail && date ? ' · '+date.replace(/-/g,'/') : ''}</Text>
      {!skuDetail && <Text style={s.note}>{quantity===null?'数量未確認':formatMetric(quantity,'quantity')} · {amount===null ? sales?'売上未確認':'原価未登録' : formatMetric(amount,'amount')}</Text>}
      {basis && <Text style={s.note}>{basis}</Text>}
      {action}
    </View>
  </View>;
}

const s=StyleSheet.create({
  pairedRings:{flexDirection:'row',gap:6},pairedPeriod:{flex:1,minWidth:0,alignItems:'center'},pairedDonut:{width:'100%',maxWidth:210,aspectRatio:1},
  pairedTitle:{fontSize:14,fontWeight:'700',color:'#214d41',textAlign:'center'},pairedDate:{fontSize:11,color:'#526359',textAlign:'right'},
  pairedNumbers:{flexDirection:'row',alignItems:'center',gap:6},pairedCell:{flex:1,minWidth:0,alignItems:'flex-end'},pairedButton:{minHeight:44,justifyContent:'center'},pairedValue:{fontSize:12,fontWeight:'700',color:'#214d41',fontVariant:['tabular-nums']},
  pairedRow:{borderBottomWidth:1,borderColor:'#e5ece7',paddingVertical:6,gap:3},pairedLabel:{flexDirection:'row',alignItems:'center',gap:6},decrease:{color:'#9b4735'},
  comparisonWide:{flexDirection:'row',alignItems:'flex-start',gap:20},comparisonColumn:{flex:1},
  section:{gap:10,minWidth:0},controls:{flexDirection:'row',flexWrap:'wrap',gap:5,alignItems:'flex-end'},
  card:{borderRadius:15,borderWidth:1,borderColor:'#e0e8e2',backgroundColor:'white',padding:12,gap:7,minWidth:0},
  summary:{backgroundColor:'#f1f6f2'},total:{color:'#214d41',fontSize:29,fontWeight:'700',fontVariant:['tabular-nums']},
  heading:{color:'#263c35',fontSize:16,fontWeight:'700'},note:{color:'#526359',fontSize:13,lineHeight:20},
  button:{minHeight:44,alignSelf:'flex-start',paddingHorizontal:9,paddingVertical:6,borderRadius:9,borderWidth:1,borderColor:'#dbe6de',justifyContent:'center',backgroundColor:'#f5f8f6'},
  buttonText:{fontSize:13,color:'#245647',fontWeight:'600'},active:{backgroundColor:'#264e47',borderColor:'#264e47'},activeText:{color:'white'},
  chartBody:{gap:12},chartWide:{flexDirection:'row',alignItems:'center',gap:28},
  donut:{width:'100%',maxWidth:245,aspectRatio:1,alignSelf:'center'},donutWide:{width:'37%'},
  percent:{minWidth:48,textAlign:'right',fontVariant:['tabular-nums']},
  legend:{flexDirection:'row',minHeight:44,alignItems:'center',gap:8,borderBottomWidth:1,borderColor:'#e8eeea',paddingVertical:6},
  dot:{height:10,width:10,borderRadius:5},grow:{flex:1,minWidth:0},label:{color:'#243b32',fontSize:14},
  value:{color:'#243b32',fontSize:15,fontWeight:'700',fontVariant:['tabular-nums']},
  productSku:{color:'#214d41',fontWeight:'700'},
  product:{flexDirection:'row',alignItems:'flex-start'},image:{width:68,height:68,borderRadius:6,backgroundColor:'#eef2ef',alignItems:'center',justifyContent:'center'},
  imageText:{fontSize:10,textAlign:'center',color:'#526359'},
});
