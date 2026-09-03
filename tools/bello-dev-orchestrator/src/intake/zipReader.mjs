/**
 * 最小 ZIP リーダー (docx 用)。
 *
 * 依存追加を避けるため node:zlib の inflateRawSync だけで実装する。
 * 理由と代替案は docs/ADR-0001 §3 を参照。
 *
 * 対応: store(0) と deflate(8)。ZIP64・暗号化は対応しないが、
 * 「非対応」を黙って空データとして返さず、明示的に例外にする。
 */
import zlib from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = "ZipError";
  }
}

function findEocd(buf) {
  const maxComment = 0xffff;
  const start = Math.max(0, buf.length - maxComment - 22);
  for (let i = buf.length - 22; i >= start; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new ZipError("ZIP の End of Central Directory が見つかりません。docx ファイルとして壊れています。");
}

/**
 * ZIP のエントリ一覧を返す。
 * @returns {Map<string, {method:number, offset:number, compressedSize:number, uncompressedSize:number}>}
 */
export function listEntries(buf) {
  const eocd = findEocd(buf);
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cenSize = buf.readUInt32LE(eocd + 12);
  const cenOffset = buf.readUInt32LE(eocd + 16);

  if (cenOffset === 0xffffffff || entryCount === 0xffff || cenSize === 0xffffffff) {
    throw new ZipError("ZIP64 形式には対応していません。ファイルを分割するか、通常の .docx として保存し直してください。");
  }

  const entries = new Map();
  let p = cenOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) {
      throw new ZipError("ZIP のセントラルディレクトリが壊れています。");
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    if (flags & 0x0001) throw new ZipError("暗号化された ZIP には対応していません。");

    entries.set(name, { method, offset: localOffset, compressedSize, uncompressedSize });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 1 エントリを展開して Buffer で返す。 */
export function readEntry(buf, entry) {
  if (buf.readUInt32LE(entry.offset) !== LOC_SIG) {
    throw new ZipError("ZIP のローカルヘッダが壊れています。");
  }
  const nameLen = buf.readUInt16LE(entry.offset + 26);
  const extraLen = buf.readUInt16LE(entry.offset + 28);
  const dataStart = entry.offset + 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new ZipError(`未対応の圧縮方式です (method=${entry.method})。`);
}

/** 名前を指定して展開する。存在しなければ null。 */
export function readFileFromZip(buf, name) {
  const entries = listEntries(buf);
  const entry = entries.get(name);
  if (!entry) return null;
  return readEntry(buf, entry);
}
