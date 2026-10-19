import {effectiveListThumbnailKey,normalizeImageRecord,resolveTopImage,type RawInventoryImage} from '@/lib/inventory/imageTypes';

/** Keep the same normal/damage and explicit-primary rules as the inventory list. */
export function outboundThumbnailFields(images:readonly (RawInventoryImage|null)[]|null|undefined) {
 const top=resolveTopImage((images??[]).filter((image):image is RawInventoryImage=>!!image).map(normalizeImageRecord));
 return {mainImageStorageKey:top?.storageKey??null,mainImageThumbnailKey:top?effectiveListThumbnailKey(top):null,mainImageIsPrimary:top?.isPrimary===true};
}
