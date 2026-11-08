import assert from 'node:assert/strict';
import {test} from 'node:test';
import {bridgePostHeaderFailure} from '../lib/listing/mercariBridge/postGuard';
const publicOrigin='https://bello.example.test';
const valid={origin:publicOrigin,requestOrigin:'http://localhost:3000',configuredPublicOrigin:publicOrigin,contentType:'application/json',hasNextAction:false};
test('approved public HTTPS origin works behind Amplify internal origin',()=>assert.equal(bridgePostHeaderFailure(valid),null));
test('foreign, missing and lookalike origins remain blocked',()=>{for(const origin of [null,'https://evil.test','https://bello.example.test.evil.test'])assert.equal(bridgePostHeaderFailure({...valid,origin}),'ORIGIN_MISMATCH');});
test('an unconfigured or non-HTTPS alternate origin cannot grant access',()=>{for(const configuredPublicOrigin of [undefined,'http://bello.example.test','https://bello.example.test/path'])assert.equal(bridgePostHeaderFailure({...valid,configuredPublicOrigin}),'ORIGIN_MISMATCH');});
test('non-JSON and server-action requests remain blocked',()=>{assert.equal(bridgePostHeaderFailure({...valid,contentType:'text/plain'}),'CONTENT_TYPE_INVALID');assert.equal(bridgePostHeaderFailure({...valid,hasNextAction:true}),'NEXT_ACTION_FORBIDDEN');});
