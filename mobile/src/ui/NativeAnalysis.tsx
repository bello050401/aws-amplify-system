import React,{useState} from 'react';
import {ActivityIndicator,Image,Pressable,StyleSheet,Text,useWindowDimensions,View} from 'react-native';
import Svg,{Circle,Path,Text as SvgText} from 'react-native-svg';
import {formatJstDateTime} from '../../../lib/inventory/sales';
import {
  analysisRequest,inventoryComparisonRequest,arcPath,categoryBasisLabel,chartBasis,chartContent,detailItemKey,detailMetricFor,displayRows,formatMetric,graphSegments,groupingFor,holdingBasisLabel,skuHoldingNote,inventoryCompositionNote,jstDay,metricFor,metricLabel,
  unknownAmount,type AnalysisRequest,type AnalysisPorts,type AnalysisState,type Bucket,type DetailGroup,type DetailItem,type Dimension,type DisplayRow,type Metric,type ProductFact,type Slice,type Target,
} from '../../../lib/inventory/analysisUi/model';
import {comparisonBuckets} from '../../../lib/inventory/analysisUi/comparison';
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
  const comparing = request?.target === 'inventory' && state.inventoryCompareWeeks > 0;
  const anchor = api.data;
  const historicalRequest = inventoryComparisonRequest(anchor?.status==='ok' ? anchor.metadata.asOf : today+'T00:00:00+09:00',state.inventoryCompareWeeks || 2);
  const comparisonDay = historicalRequest.daily!;
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

  const comparisonDimensions = api.data?.status==='ok' && historical.data?.status==='ok' && (metric!=='skus' || historical.data.summary.skus!==undefined)
    ? chartContent('inventory',metric,detailed).map(chart=>chart.dimension) : [undefined];
  if (offline) return <Text style={s.note}>通信できる状態で集計を確認してください。</Text>;
  return <View style={s.section}>
    {request?.target === 'inventory' && <View style={s.section}>
      {button('過去の在庫と比較',()=>change({inventoryCompareWeeks:comparing?0:2}),comparing)}
      {comparing && <Choices label="在庫の比較期間" value={String(state.inventoryCompareWeeks)} options={[{key:'2',label:'2週間前'},{key:'3',label:'3週間前'},{key:'4',label:'4週間前'}] as const} select={weeks=>change({inventoryCompareWeeks:Number(weeks) as 2|3|4})}/>}
    </View>}
    {comparing ? comparisonDimensions.map((dimension,index)=><View key={dimension || 'unavailable'} style={[s.section,comparisonWide && s.comparisonWide]}>
      <View accessibilityLabel="比較・基準の在庫" style={[s.section,comparisonWide && s.comparisonColumn]}>
        <Text accessibilityRole="header" style={s.heading}>{request?.daily ? request.daily.replace(/-/g,'/')+'の在庫' : '現在の在庫'}</Text>
        {metric!=='skus' && api.data?.status==='ok' && <Text style={s.note}>{formatJstDateTime(api.data.metadata.asOf)} JST 時点</Text>}
        {request && renderResult(api,metric,request,false,dimension,index===0)}
      </View>
      <View accessibilityLabel="比較・過去の在庫" style={[s.section,comparisonWide && s.comparisonColumn]}>
        <Text accessibilityRole="header" style={s.heading}>{state.inventoryCompareWeeks}週間前{anchor?.status==='ok' ? ' · '+comparisonDay.replace(/-/g,'/') : ''}</Text>
        {metric!=='skus' && historical.data?.status==='ok' && <Text style={s.note}>{formatJstDateTime(historical.data.metadata.asOf)} JST 時点</Text>}
        {anchor?.status!=='ok' ? <Text style={s.note}>基準の在庫データを取得すると比較できます。</Text> : renderResult(historical,metric,historicalRequest,true,dimension,index===0)}
      </View>
    </View>) : request && renderResult(api,metric,request)}
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
