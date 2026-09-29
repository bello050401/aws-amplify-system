import assert from "node:assert/strict";
import { parsePhotoObservations } from "@/lib/ai/productPage/photoObservation";

assert.deepEqual(parsePhotoObservations("not json"), [], "Malformed model output must not become evidence");
assert.deepEqual(parsePhotoObservations('{"observations":"white"}'), [], "Wrong schema must not become evidence");
assert.deepEqual(
  parsePhotoObservations('{"observations":["白い円形の天板が見える","本革の高級チェアです","黒い脚が四本見える",42]}'),
  ["白い円形の天板が見える", "黒い脚が四本見える"],
  "Only bounded appearance observations may be passed to the introduction",
);
assert.equal(parsePhotoObservations(JSON.stringify({ observations: ["長".repeat(121)] })).length, 0);
console.log("Photo observation boundary: 4 passed");
