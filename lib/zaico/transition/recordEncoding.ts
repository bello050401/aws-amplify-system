import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import type {Row} from './mapping';

// Only internal, non-queryable snapshots are compressed. Control/lease rows,
// inventory data, keys, versions and the admin-visible status remain ordinary
// DynamoDB attributes. Reads are still strongly consistent, never cached.
const FIELDS=['remote','remoteBase','localBase','rawValues','desired','rejectedDesired','conflict'] as const;
const FORMAT='gzip-json-v1';
const STORAGE=['snapshotEncoding','snapshotGzip','snapshotSha256'] as const;
const MAX_JSON_BYTES=2*1024*1024;
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

export function decodeTransitionRecord(row:Row):Row {
  if(!STORAGE.some(key=>Object.hasOwn(row,key)))return row;
  if(!String(row.id??'').startsWith('transition#item#')||row.snapshotEncoding!==FORMAT||
    !(row.snapshotGzip instanceof Uint8Array)||typeof row.snapshotSha256!=='string')
    throw Error('同期記録の保存形式を確認できません。基準データは変更しません。');
  const bytes=gunzipSync(row.snapshotGzip,{maxOutputLength:MAX_JSON_BYTES});
  if(digest(bytes)!==row.snapshotSha256)throw Error('同期記録の検証に失敗しました。基準データは変更しません。');
  const values:unknown=JSON.parse(bytes.toString('utf8'));
  if(!values||typeof values!=='object'||Array.isArray(values)||
    Object.keys(values).some(key=>!FIELDS.includes(key as typeof FIELDS[number])||Object.hasOwn(row,key)))
    throw Error('同期記録の項目を確認できません。基準データは変更しません。');
  const result={...row,...values};
  for(const key of STORAGE)delete result[key];
  return result;
}

export function encodeTransitionRecord(input:Row):Row {
  const row=decodeTransitionRecord(input);
  if(!String(row.id??'').startsWith('transition#item#'))return row;
  const values=Object.fromEntries(FIELDS.filter(key=>row[key]!==undefined).map(key=>[key,row[key]]));
  if(!Object.keys(values).length)return row;
  const bytes=Buffer.from(JSON.stringify(values));
  if(bytes.length>MAX_JSON_BYTES)throw Error('同期記録のサイズ上限を超えています。');
  const compressed=gzipSync(bytes,{level:6});
  // Keep tiny/uncompressible records in their existing representation.
  if(compressed.length+200>=bytes.length)return row;
  const result:Row={...row,snapshotEncoding:FORMAT,snapshotGzip:compressed,snapshotSha256:digest(bytes)};
  for(const key of FIELDS)delete result[key];
  return result;
}
