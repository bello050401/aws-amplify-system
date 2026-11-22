import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { isExpectedFeatureError } from './expectedFeature';
import { safeErrorClass } from './client';
import type { SystemErrorSignal } from './contract';
type ProcurementReport = (error:unknown,provider:'yahoo'|'trefac'|'restage',operation:'fetch'|'enrich'|'register')=>Promise<boolean>;
function fixture() {
  const sent: SystemErrorSignal[] = [], exports = {} as {reportProcurementError:ProcurementReport};
  const code = ts.transpileModule(fs.readFileSync(new URL('./procurement.ts', import.meta.url), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(code, {exports, Error, require:(name:string) => {
    if(name==='./expectedFeature')return {isExpectedFeatureError};
    if(name==='./client')return {safeErrorClass};
    if(name==='./server')return {reportServerSystemError:async(value:SystemErrorSignal)=>{sent.push(JSON.parse(JSON.stringify(value)) as SystemErrorSignal);return true;}};
    throw Error('Unexpected dependency');
  }});
  return {sent,report:exports.reportProcurementError};
}
test('supplier/auth/user correction failures do not launch code repair', async () => {
  const {sent,report}=fixture();
  for(const message of ['GMAIL_RATE_LIMIT','ログインが必要です','認証の有効期限が切れました','数量を入力してください','同名の既存商品があります','取得結果が不正です。'])assert.equal(await report(new Error(message),'yahoo','fetch'),false);
  const cancelled=new Error('cancelled');cancelled.name='AbortError';assert.equal(await report(cancelled,'restage','fetch'),false);
  assert.equal(sent.length,0);
});
test('photo parsing defects reach the correct component without raw business data', async () => {
  const {sent,report}=fixture();const error=new TypeError('customer@example.invalid secret=not-a-real-key title=PRIVATE');
  assert.equal(await report(error,'yahoo','enrich'),true);
  assert.deepEqual(sent,[{code:'PROCUREMENT_ENRICH_FAILED',surface:'server',component:'procurement-yahoo',operation:'enrich',errorClass:'TypeError'}]);
});
test('unexpected registration failures preserve source and stage', async () => {
  const {sent,report}=fixture();
  for(const provider of ['yahoo','trefac','restage'] as const)assert.equal(await report(new Error('Unexpected transaction failure'),provider,'register'),true);
  assert.deepEqual(sent.map(s=>[s.code,s.component,s.operation]),['yahoo','trefac','restage'].map(p=>['PROCUREMENT_REGISTER_FAILED','procurement-'+p,'register']));
});
