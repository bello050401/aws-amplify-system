import assert from 'node:assert/strict';
import { slotPreviewKey, type ImageEditorSlot } from '../app/inventory/ImageEditor';

const existing: ImageEditorSlot = {
  id: 'image', kind: 'existing', storageKey: 'original', thumbnailKey: 'small', mediumKey: 'medium',
  isPrimary: true, sourceSystem: null, sourceUrl: null, originalHash: null, classification: null,
};
const copy: ImageEditorSlot = {
  id: 'copy', kind: 'copy', sourceStorageKey: 'original', sourceThumbnailKey: 'small', sourceMediumKey: 'medium',
  isPrimary: true, sourceSystem: null, sourceUrl: null, sourceOriginalHash: null, sourceClassification: null,
};
assert.equal(slotPreviewKey(existing), 'medium');
assert.equal(slotPreviewKey(existing, 'small'), 'small');
assert.equal(slotPreviewKey({...existing, mediumKey: null}), 'small');
assert.equal(slotPreviewKey({...existing, mediumKey: null, thumbnailKey: null}), 'original');
assert.equal(slotPreviewKey(copy), 'medium');
assert.equal(slotPreviewKey(copy, 'small'), 'small');
assert.equal(slotPreviewKey({...copy, sourceMediumKey: null, sourceThumbnailKey: null}), 'original');
assert.equal(existing.storageKey, 'original');
assert.equal(copy.sourceStorageKey, 'original');
console.log('9 checks passed: display-sized previews, legacy fallback, original references preserved.');
