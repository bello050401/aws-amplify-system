/**
 * 画像まとめダウンロード用のZIP組み立て(純粋関数、外部I/Oなし)。
 *
 * なぜ自前実装か: このworktreeは`npm install`が使えない環境のため
 * package.jsonに無い依存(archiver/jszip等)を新規に追加できない
 * (`node_modules`が実在せず、追加してもロックファイルを正しく
 * 更新する手段が無い)。画像(jpg/png)は既に圧縮済みで再圧縮の効果が
 * 薄いため、格納方式(STORE、無圧縮)のみのZIPで十分——ZIP仕様の
 * ローカルファイルヘッダ+セントラルディレクトリだけを実装すれば良い。
 *
 * なぜUint8ArrayでNode Bufferを使わないか(task_f712cf24a9fe2308cd、
 * 2026-09-14): 当初はBuffer.alloc/Buffer.concatで実装していたが、ZIP
 * 組み立て自体をブラウザ側(browserImageZip.ts)へ移したため、Node専用の
 * Bufferに依存できなくなった——Bufferはブラウザ標準APIではなく、
 * webpackが自動polyfillする保証も無い。Uint8Array/DataViewはNode・
 * ブラウザ双方の標準APIなので、この関数はどちらの実行環境からも
 * 変更なしで呼べる(assembleRow.tsと同じ理由でserver-only/next-headers
 * 非依存にもしてある——合成fixtureでバイト単位の往復検証ができるように
 * するため。scripts/verify-mercari-csv-export.ts参照)。
 */
import { crc32 } from "./crc32";

export interface ZipEntryInput {
  filename: string;
  data: Uint8Array;
}

export interface ZipBuildResult {
  ok: boolean;
  bytes?: Uint8Array;
  /** 0件、または合計サイズ超過など、組み立て自体を拒否した理由。 */
  reason?: string;
}

/** 呼び出し側(imageBundle.ts/browserImageZip.ts)の既定上限と揃えるための下限チェックのみ。実際の上限値は呼び出し側で保有する。 */
export const MIN_ZIP_ENTRY_COUNT = 1;

function dosDateTime(date: Date): { time: number; date: number } {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const dosDate = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, date: dosDate };
}

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}
function u16le(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n & 0xffff, true);
  return b;
}
function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * 無圧縮(STORE)ZIPを組み立てる。ファイル名の重複はそのまま許容せず
 * 呼び出し側(imageBundle.ts/browserImageZip.ts)で一意性(displayId_連番)を
 * 保証済みの前提。0件は拒否する(空ZIPを「成功」として返さない)。
 */
export function buildStoredZip(entries: ZipEntryInput[]): ZipBuildResult {
  if (entries.length < MIN_ZIP_ENTRY_COUNT) {
    return { ok: false, reason: "ZIPに含める画像が0件です" };
  }

  const { time, date } = dosDateTime(new Date());
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = utf8Bytes(entry.filename);
    const data = entry.data;
    const crc = crc32(entry.data);
    const size = data.length;

    const localHeader = concatBytes([
      u32le(0x04034b50),
      u16le(20), // version needed
      u16le(0x0800), // UTF-8 filename flag
      u16le(0), // method: store
      u16le(time),
      u16le(date),
      u32le(crc),
      u32le(size), // compressed size = uncompressed (store)
      u32le(size),
      u16le(nameBuf.length),
      u16le(0), // extra length
    ]);
    localParts.push(localHeader, nameBuf, data);

    const centralHeader = concatBytes([
      u32le(0x02014b50),
      u16le(20), // version made by
      u16le(20), // version needed
      u16le(0x0800),
      u16le(0),
      u16le(time),
      u16le(date),
      u32le(crc),
      u32le(size),
      u32le(size),
      u16le(nameBuf.length),
      u16le(0), // extra length
      u16le(0), // comment length
      u16le(0), // disk number start
      u16le(0), // internal attrs
      u32le(0), // external attrs
      u32le(offset), // local header offset
    ]);
    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + data.length;
  }

  const centralDirectory = concatBytes(centralParts);
  const centralDirectoryOffset = offset;

  const endRecord = concatBytes([
    u32le(0x06054b50),
    u16le(0), // disk number
    u16le(0), // disk with central dir
    u16le(entries.length), // entries on this disk
    u16le(entries.length), // total entries
    u32le(centralDirectory.length),
    u32le(centralDirectoryOffset),
    u16le(0), // comment length
  ]);

  const bytes = concatBytes([...localParts, centralDirectory, endRecord]);
  return { ok: true, bytes };
}
