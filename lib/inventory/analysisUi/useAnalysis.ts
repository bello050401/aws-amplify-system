import {useEffect,useState} from 'react';
import type {AnalysisPorts, AnalysisRequest, AnalysisResult, DetailItem, DetailResult, Slice} from './model';

export function useAnalysis(load:AnalysisPorts['load']|undefined, request:AnalysisRequest|null, available=true) {
  const key = request ? JSON.stringify(request) : '';
  const [result,setResult] = useState<{key:string; value:AnalysisResult}>();
  const [attempt,setAttempt] = useState(0);
  useEffect(()=>{
    if (!load || !available || !key) return;
    let active = true;
    const requested = JSON.parse(key) as AnalysisRequest;
    void load(requested).then(
      value=>{
        if (!active) return;
        const mismatch = value.status==='ok' && requested.generation && value.metadata.generation!==requested.generation;
        setResult({key,value:mismatch ? {status:'expired'} : value});
      },
      ()=>{if (active) setResult({key,value:{status:'error'}});},
    );
    return ()=>{active = false;};
  },[load,key,attempt,available]);
  return {
    data:!available || !load ? {status:'error'} as const : result?.key === key ? result.value : null,
    retry:()=>{setResult(undefined);setAttempt(attempt+1);},
  };
}

export function useDetail(drill:AnalysisPorts['drill']|undefined, slice:Slice, groupKindId?:string) {
  const {request,dimension,key} = slice;
  const [items,setItems] = useState<DetailItem[]>([]);
  const [next,setNext] = useState<string|null>(null);
  const [pending,setPending] = useState(true);
  const [error,setError] = useState<Exclude<DetailResult['status'],'ok'>|null>(null);
  const [page,setPage] = useState<{cursor?:string}>({});
  const query = JSON.stringify({ ...request,dimension,key,groupKindId });
  useEffect(()=>{
    if (!drill) {setError('error');setPending(false);return;}
    let active = true;
    void drill({...JSON.parse(query),cursor:page.cursor,limit:24}).then(value=>{
      if (!active) return;
      if (value.status === 'ok') {
        setItems(previous=>page.cursor ? [...previous,...value.items] : value.items);
        setNext(value.nextCursor ?? null);
      } else setError(value.status);
    },()=>{if (active) setError('error');}).finally(()=>{if (active) setPending(false);});
    return ()=>{active = false;};
  },[drill,query,page]);
  function load(cursor?:string) {
    setPending(true);
    setError(null);
    setPage({cursor});
  }
  return {items,pending,error,more:next ? ()=>load(next) : undefined,retry:()=>load(page.cursor)};
}
