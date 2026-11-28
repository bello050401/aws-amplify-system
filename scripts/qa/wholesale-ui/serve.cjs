const path = require('node:path'), fs = require('node:fs'), http = require('node:http'), esbuild = require('esbuild');
const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const out = path.join(root, 'artifacts/wholesale-ui'); fs.mkdirSync(out, { recursive: true });
const link = path.join(out, 'link.tsx');
fs.writeFileSync(link, 'import React from "react";export default function Link({children,...props}:React.ComponentProps<"a">){return <a {...props}>{children}</a>}');
esbuild.buildSync({ absWorkingDir: root, entryPoints: [path.join(__dirname, 'main.tsx')], bundle: true, outfile: path.join(out, 'ui.js'), platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, alias: { 'next/link': link }, tsconfig: path.join(root, 'tsconfig.json') });
async function start() {
 const css = await require('postcss')([require('tailwindcss')({ content: [path.join(root, 'app/inventory/(protected)/listings/WholesaleTable.tsx'), path.join(__dirname, 'main.tsx')], theme: { extend: {} }, plugins: [] })]).process('@tailwind base;@tailwind components;@tailwind utilities;body{font-family:system-ui,sans-serif}', { from: undefined });
 const html = '<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BELLO 業販 検証環境</title><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/ui.js"></script></html>';
 const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#e4eae7"/><rect x="48" y="25" width="64" height="55" rx="8" fill="#b7a080"/><path d="M40 85H120V98H40ZM50 98L40 140M110 98L120 140" fill="#8b7355" stroke="#8b7355" stroke-width="5"/></svg>';
 http.createServer((req, res) => { const u = new URL(req.url, 'http://127.0.0.1'); res.setHeader('Cache-Control', 'no-store'); if (req.method !== 'GET') { res.writeHead(405); return res.end(); } if (u.pathname === '/ui.js') { res.setHeader('Content-Type', 'text/javascript'); return fs.createReadStream(path.join(out, 'ui.js')).pipe(res); } if (u.pathname === '/style.css') { res.setHeader('Content-Type', 'text/css'); return res.end(css.css); } if (u.pathname === '/fixture.svg') { res.setHeader('Content-Type', 'image/svg+xml'); return res.end(svg); } res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end(html); }).listen(43144, '127.0.0.1', () => console.log('Wholesale fixture http://127.0.0.1:43144'));
}
if (!process.argv.includes('--bundle-only')) start().catch(error => { console.error(error); process.exitCode = 1; });
