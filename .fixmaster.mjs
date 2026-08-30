import fs from "fs";
const p="app/inventory/(protected)/settings/MasterList.tsx";
let s=fs.readFileSync(p,"utf8");
const before=s;

// ↑↓ — CustomFieldSettings/ListColumnSettings と同じ 32px 角の当たり判定へ
s=s.replace(
`                  <button type="button" onClick={() => move(index, -1)} disabled={readOnly || pending || index === 0} className="disabled:text-gray-200">
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={readOnly || pending || index === entries.length - 1}
                    className="disabled:text-gray-200"
                  >
                    ↓
                  </button>`,
`                  {/* CustomFieldSettings.tsx と同じ理由 — グリフだけだと
                      実測13x20pxで、モバイル(375-430px)では隣と押し分けら
                      れない。文字サイズは変えずに当たり判定だけ32px角へ。
                      設定画面の既定タブがここなので、実際に一番よく触られる。 */}
                  <button
                    type="button"
                    onClick={() => move(index, -1)}
                    disabled={readOnly || pending || index === 0}
                    aria-label={\`\${entry.name}を上へ\`}
                    className="inline-flex min-h-8 min-w-8 items-center justify-center disabled:text-gray-200"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={readOnly || pending || index === entries.length - 1}
                    aria-label={\`\${entry.name}を下へ\`}
                    className="inline-flex min-h-8 min-w-8 items-center justify-center disabled:text-gray-200"
                  >
                    ↓
                  </button>`);

// 有効/無効ピル — 実測51x23。高さだけ32pxへ。
s=s.replace(
`                  className={\`inline-flex items-center gap-1 border px-1.5 py-0.5 text-[11px] \${
                    entry.isActive ? "border-gray-300 text-gray-600" : "border-gray-200 text-gray-400"
                  } \${readOnly ? "" : "hover:bg-gray-50"}\`}`,
`                  className={\`inline-flex min-h-8 items-center gap-1 border px-2 py-0.5 text-[11px] \${
                    entry.isActive ? "border-gray-300 text-gray-600" : "border-gray-200 text-gray-400"
                  } \${readOnly ? "" : "hover:bg-gray-50"}\`}`);

// 「削除」— 実測24x18。文字サイズは変えずに当たり判定を広げる。
s=s.replace(
`                  <button type="button" onClick={() => handleDelete(entry)} disabled={pending} className="text-[12px] text-red-400 hover:text-red-600">
                    削除
                  </button>`,
`                  <button
                    type="button"
                    onClick={() => handleDelete(entry)}
                    disabled={pending}
                    className="inline-flex min-h-8 min-w-8 items-center justify-center text-[12px] text-red-400 hover:text-red-600"
                  >
                    削除
                  </button>`);

// 選択チェックボックス — 実測13x13。見た目は据え置き、当たり判定だけ広げる。
s=s.replace(
`                  <input
                    type="checkbox"
                    checked={selectedIds.has(entry.id)}
                    onChange={() => toggleSelected(entry.id)}
                    aria-label={\`\${entry.name} を選択\`}
                  />`,
`                  {/* チェックボックス自体は13x13のまま(見た目を変えない)、
                      labelで包んで押せる範囲だけを32px角へ広げる。 */}
                  <label className="inline-flex min-h-8 min-w-8 cursor-pointer items-center justify-center">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(entry.id)}
                      onChange={() => toggleSelected(entry.id)}
                      aria-label={\`\${entry.name} を選択\`}
                    />
                  </label>`);

if(s===before) throw new Error("何も置換されなかった");
fs.writeFileSync(p,s,"utf8");
console.log("MasterList.tsx を更新");
