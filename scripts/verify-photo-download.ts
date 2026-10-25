import assert from 'node:assert/strict';
import {photoDownloadResponse} from '../lib/photoRegistration/downloadResponse';
async function main(){
 const url=new URL('https://photos.s3.us-west-2.amazonaws.com/original.bin');
 url.searchParams.set('response-content-disposition',"attachment; filename*=UTF-8''"+encodeURIComponent('白いベンチ ①.jpg'));
 const request=new Request('https://bello.test/api/photo-download',{headers:{Accept:'application/json'}});
 const result=photoDownloadResponse(request,url.href);
 assert.equal(result.status,200);assert.equal(result.headers.get('location'),null);
 assert.match(result.headers.get('cache-control')??'',/no-store/);
 assert.equal(result.headers.get('vary'),'Accept');
 assert.deepEqual(await result.json(),{url:url.href,fileName:'白いベンチ ①.jpg'});
 url.searchParams.set('response-content-disposition',"attachment; filename*=UTF-8''"+encodeURIComponent('../bad\r\n.jpg'));
 assert.equal((await photoDownloadResponse(request,url.href).json()).fileName,'.._bad__.jpg');
 const direct=photoDownloadResponse(new Request('https://bello.test/api/photo-download'),url.href);
 assert.equal(direct.status,302);assert.equal(direct.headers.get('location'),url.href);
 console.log('PASS: authorized download metadata, Japanese filename, no-cache, filename sanitization, legacy link');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
