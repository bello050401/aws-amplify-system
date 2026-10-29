'use client';
import {useCallback} from 'react';
import {useRouter} from 'next/navigation';
import {PriceEntryScreen} from '@/components/inventory/PriceEntryScreen';
import {useUnsavedChanges} from '../../UnsavedChangesProvider';
export default function PriceEntryPage(){const router=useRouter();const {setDirty,registerSaveHandler}=useUnsavedChanges();const saveReady=useCallback((save:(()=>Promise<boolean>)|null)=>registerSaveHandler(save?async()=>({success:await save()}):null),[registerSaveHandler]);return <main className="min-h-0 w-full flex-1 overflow-y-auto"><PriceEntryScreen onDirty={setDirty} onSaveReady={saveReady} onClose={()=>{setDirty(false);router.push('/inventory');}}/></main>;}
