import assert from "node:assert/strict";
import {previewRejectionReason} from "../lib/listing/yahooAuction/webHttpPreview";
const error='<div class="decErrorBox"><p class="decErrorBox__title">すでに同じタイトルのオークションが出品されています。タイトルを変更してください。</p></div>';
assert.equal(previewRejectionReason(error),'DUPLICATE_TITLE');
for(const ancestor of ['style="display: none;"','hidden','class="Modal is-hide"'])assert.equal(previewRejectionReason(`<div ${ancestor}>${error}</div>`),null);
assert.equal(previewRejectionReason('<p>すでに同じタイトルのオークションが出品されています</p>'),null);
console.log('PASS: visible Yahoo duplicate title error is explained; hidden templates and unrecognized text never count');
