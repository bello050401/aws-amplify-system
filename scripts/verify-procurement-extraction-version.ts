import assert from 'node:assert/strict';
import {ExtractionRepository,type ExtractionJob} from '../lib/procurement/extraction/jobs';
import {extractDimensions} from '../lib/procurement/extraction/dimensions';
import {descriptionBlocks,sha} from '../lib/procurement/extraction/sources';
import {EXTRACTION_VERSION} from '../lib/procurement/extraction/types';

async function main(){
 const identity={provider:'YAHOO' as const,account:'BELLO-primary',externalId:'r1234567890',inventoryId:'version-qa',row:'auction'};
 const result=extractDimensions({identity,url:'https://auctions.yahoo.co.jp/jp/auction/r1234567890',hash:sha('W715mm'),acquiredAt:'2026-11-07T00:00:00Z',format:'yahoo-description-html-v1',complete:true,targetVerified:true,blocks:descriptionBlocks('W715mm'),issues:[]});
 const job:ExtractionJob={pk:'EXTRACTION#version-qa',sk:'CURRENT',identity,revision:'qa',state:'APPLIED',createdAt:'qa',updatedAt:'qa',requestedBy:'QA',resultKey:'procurement-sources/qa/result.json'};
 const repo=new ExtractionRepository({region:'us-west-2',table:'not-used',bucket:'not-used',inventoryTable:'not-used',historyTable:'not-used'});
 let body=structuredClone(result),inventoryReads=0;
 repo.object=async()=>Buffer.from(JSON.stringify(body));
 repo.inventory=async()=>{inventoryReads++;throw Error('Unexpected inventory access');};
 body.version='supplier-dimensions-2026-11-07.1';
 assert.equal((await repo.result(job)).version,body.version);
 assert.equal((await repo.result({...job,state:'REVIEW'})).version,body.version);
 console.log('PASS historical confirmed and pending evidence remain readable after release');
 await assert.rejects(()=>repo.apply({...job,state:'REVIEW'},body,'qa','QA'),/読取方式が更新/);
 assert.equal(inventoryReads,0);
 console.log('PASS stale version cannot write inventory, even through direct repository call');
 body.version=EXTRACTION_VERSION;
 assert.equal((await repo.result(job)).dimensions[0].mm,715);
 console.log('PASS current version remains readable');
 body.source.identity.externalId='r9999999999';
 await assert.rejects(()=>repo.result(job),/資料版が一致/);
 console.log('PASS another auction cannot supply historical or current evidence');
 body=structuredClone(result);body.version='unrecognized-version';
 await assert.rejects(()=>repo.result(job),/資料版が一致/);
 console.log('PASS unknown result schema is rejected');
 console.log('5 version-regression checks passed; no AWS data accessed');
}
main().catch(e=>{console.error(e);process.exitCode=1});
