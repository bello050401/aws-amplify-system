import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkLoginSession} from '../lib/amplify/loginSessionCheck';
for(const status of ['authorized','signed-in-not-authorized','signed-out'] as const)test('normal session '+status,async()=>assert.deepEqual(await checkLoginSession(async()=>status),{status,failed:false}));
test('rejected identity service presents login instead of indefinite spinner',async()=>assert.deepEqual(await checkLoginSession(async()=>{throw Error('private upstream detail');}),{status:'signed-out',failed:true}));
test('hung identity request is bounded and never grants access',async()=>assert.deepEqual(await checkLoginSession(()=>new Promise(()=>{}),10),{status:'signed-out',failed:true}));
