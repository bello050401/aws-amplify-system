/** Decode a bounded local POST once, after collecting its raw bytes. */
export async function readGeneralPrivateCreateRequestJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) throw Error("GENERAL_PRIVATE_CREATE_BODY_UNVERIFIED");
    size += chunk.length;
    if (size > 65536) throw Error("GENERAL_PRIVATE_CREATE_BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  const text = new TextDecoder("utf-8", { fatal: true })
    .decode(Buffer.concat(chunks, size));
  return JSON.parse(text);
}
