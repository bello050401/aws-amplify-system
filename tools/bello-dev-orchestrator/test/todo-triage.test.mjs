import test from 'node:test';import assert from 'node:assert/strict';
import {planTodos,requestOwner,TodoTriage} from '../src/todo/triage.mjs';
import {buildHarness,initRepo} from './helpers.mjs';import {Store} from '../src/store/db.mjs';import {Repo} from '../src/store/repo.mjs';import {makeReport} from '../src/runner/fakeRunner.mjs';import {makeReview} from '../src/review/fakeReview.mjs';
const todo=(id,title,task='t',extra={})=>({id,title,status:'open',category:'other',waitingTaskIds:[task],created_at:'2026-09-16',...extra});
test('only current human blocker foreground; old pending approval deferred and terminal archived',()=>{
 const tasks=[{id:'t',state:'awaiting_user'},{id:'old',state:'awaiting_user'},{id:'done',state:'completed'}];
 const rows=planTodos([todo('1','本番デプロイ'),todo('2','本番へ公開','old'),todo('3','git commit','done'),todo('4','テストを再実行')],tasks,{currentTaskId:'t'});
 assert.equal(rows.find(x=>x.id==='1').triage.bucket,'now');assert.equal(rows.find(x=>x.id==='2').triage.bucket,'later');assert.equal(rows.find(x=>x.id==='3').triage.bucket,'archive');assert.equal(rows.find(x=>x.id==='4').triage.bucket,'ai');
});
test('approval categories do not turn ordinary git into human work; sensitive actions stay human',()=>{
 assert.equal(requestOwner(todo('1','git commit', 't',{category:'approval'})),'ai');
 for(const title of ['production deploy','本番データ大量更新','破壊的DB migration','IAM権限追加','S3ポリシー変更','Cognito削除','実EC出品','ZAICO本番データ変更','課金操作','MFA入力','OAuth認証','ログイン'])assert.equal(requestOwner(todo('x',title)),'human',title);
 assert.equal(requestOwner(todo('x','色の希望')),'later');
});
test('duplicates retain original records and merge only identical action/target/condition',()=>{
 const a=todo('a','再テスト','t',{action_required:'node test',completion_condition:'pass'});const b=todo('b','再テスト','u',{action_required:'node test',completion_condition:'pass'});const c=todo('c','再テスト','u',{action_required:'another test',completion_condition:'pass'});
 const rows=planTodos([a,b,c],[{id:'t',state:'running'},{id:'u',state:'queued'}]);assert.equal(rows.find(x=>x.id==='b').triage.classification,'duplicate');assert.deepEqual(rows.find(x=>x.id==='a').waitingTaskIds,['t','u']);assert.equal(rows.find(x=>x.id==='c').triage.bucket,'ai');assert.deepEqual(a.waitingTaskIds,['t']);
});
test('paused historical items revive when related task runs; no arbitrary five-item cap',()=>{
 const list=Array.from({length:7},(_,i)=>todo(''+i,'本番デプロイ '+i));assert.ok(planTodos(list,[{id:'t',state:'paused'}]).every(t=>t.triage.bucket==='archive'));assert.equal(planTodos(list,[{id:'t',state:'running'}]).filter(t=>t.triage.bucket==='now').length,7);
});
test('classification and queue survive database reopening without changing task/TODO status; repeated runs idempotent',async()=>{
 const h=await buildHarness();try{const task=h.repo.createTask({title:'task',instruction:'test',repoPath:h.config.repoPath}).task;h.repo.createTodo({title:'再テスト',waitingTaskIds:[task.id]});const before=h.repo.getTask(task.id);const triage=new TodoTriage({repo:h.repo});const first=triage.reconcile();const audits=h.store.all('SELECT * FROM audit_log').length;triage.reconcile();assert.equal(h.store.all('SELECT * FROM audit_log').length,audits);assert.deepEqual(h.repo.getTask(task.id),before);const other=await Store.open(h.paths.dbFile);try{assert.deepEqual(new TodoTriage({repo:new Repo(other)}).reconcile().counts,first.counts);assert.equal(other.get('SELECT state FROM todo_ai_queue').state,'pending');assert.equal(other.get('SELECT status FROM todos').status,'open')}finally{other.close()}}finally{h.cleanup()}
});
test('ordinary request-user-action routes to bounded AI retry instead of human wait',async()=>{
 const h=await buildHarness();try{initRepo(h.config.repoPath);const task=h.repo.createTask({title:'test',instruction:'work',repoPath:h.config.repoPath}).task;h.runner.setDefault({kind:'success',report:makeReport(task.id,{userActions:[{category:'approval',title:'再テスト',reason:'test locally',completionCondition:'pass'}]})});h.reviewEngine.setDefault({kind:'review',review:makeReview('request_user_action')});await h.orchestrator.tick();assert.equal(h.repo.getTask(task.id).state,'retry_wait');assert.equal(h.todoManager.triage.reconcile().counts.now,0);}finally{h.cleanup()}
});

test('completed focus never resurrects an archived human approval',()=>{assert.equal(planTodos([todo('1','本番デプロイ')],[{id:'t',state:'completed'}],{currentTaskId:'t'})[0].triage.bucket,'archive')});
test('duplicate human blocker on active task promotes the shared canonical card',()=>{const rows=planTodos([todo('a','MFA入力','old'),todo('b','MFA入力','new')],[{id:'old',state:'paused'},{id:'new',state:'running'}]);assert.equal(rows.find(t=>t.id==='a').triage.bucket,'now');assert.equal(rows.find(t=>t.id==='b').triage.bucket,'archive')});
test('verified AI completion closes only assigned AI requests and keeps task status',async()=>{const h=await buildHarness();try{const task=h.repo.createTask({title:'task',instruction:'test',repoPath:h.config.repoPath}).task;h.repo.createTodo({title:'再テスト',waitingTaskIds:[task.id]});h.repo.createTodo({title:'本番デプロイ',waitingTaskIds:[task.id]});h.todoManager.triage.markRunning(task.id);h.todoManager.triage.completeVerified(task.id);assert.equal(h.repo.listTodos({status:'open'}).length,2);h.store.run("UPDATE tasks SET state='completed' WHERE id=?",[task.id]);h.todoManager.triage.completeVerified(task.id);assert.equal(h.repo.listTodos({status:'open'})[0].title,'本番デプロイ');assert.equal(h.repo.getTask(task.id).state,'completed')}finally{h.cleanup()}});
