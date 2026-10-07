import http from "node:http";

const html = `<!doctype html>
<html lang="ja"><meta charset="utf-8"><title>Local form event fixture</title>
<style>body{font:16px system-ui;max-width:800px;margin:28px auto;padding:0 18px}label{display:block;margin:14px 0}input,textarea{display:block;width:100%;box-sizing:border-box;padding:8px}textarea{height:90px}button{padding:8px 14px;margin:8px 8px 8px 0}pre{background:#f2f2f2;padding:12px;min-height:120px;white-space:pre-wrap}</style>
<h1>ローカル入力イベント確認</h1>
<p>このページは127.0.0.1上だけで動きます。入力値は記録・送信しません。送信イベントもブラウザー内で止めます。</p>
<form id="test-form" action="#" autocomplete="off">
<label>商品名<input id="title" type="text"></label>
<label>説明<textarea id="description"></textarea></label>
<label>管理コード<input id="sku" type="text"></label>
<label>価格<input id="price" type="number"></label>
<button id="submit-button" type="submit">送信イベント確認</button>
<button id="reset-button" type="button">カウンターをリセット</button>
</form>
<h2>イベント数</h2><pre id="counts"></pre>
<h2>直近イベント（値は表示しません）</h2><pre id="events"></pre>
<script>
const form=document.getElementById('test-form');
const counts={input:0,change:0,focusout:0,enterKeydown:0,submit:0,submitButtonClick:0};
const events=[];
function show(){document.getElementById('counts').textContent=JSON.stringify(counts,null,2);document.getElementById('events').textContent=events.slice(-20).join('\\n')||'なし';}
function record(kind,target){counts[kind]++;events.push(kind+' / '+(target?.id||'form'));show();}
for(const kind of ['input','change','focusout'])form.addEventListener(kind,event=>record(kind,event.target));
form.addEventListener('keydown',event=>{if(event.key==='Enter')record('enterKeydown',event.target);});
form.addEventListener('submit',event=>{event.preventDefault();record('submit',form);});
document.getElementById('submit-button').addEventListener('click',event=>record('submitButtonClick',event.target));
document.getElementById('reset-button').addEventListener('click',()=>{for(const key of Object.keys(counts))counts[key]=0;events.length=0;show();});
show();
</script></html>`;

const server = http.createServer((request, response) => {
  if (request.method !== "GET" || request.url !== "/") {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
  });
  response.end(html);
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`http://127.0.0.1:${address.port}/\n`);
});
