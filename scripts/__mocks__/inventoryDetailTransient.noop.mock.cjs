'use strict';
const Noop = () => null;
module.exports = new Proxy({}, { get(_target, property) {
  if (property === 'then') return undefined;
  if (property === 'listInventoryPhotoAssetsAction') return async () => ({ ok: true, value: { assets: [] } });
  return Noop;
} });
