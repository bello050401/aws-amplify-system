"use client";

import { usePrimaryPhotoThumbnails } from "../usePrimaryPhotoThumbnails";
import { InventoryTable } from "./InventoryTable";
import type { ComponentProps } from "react";

type Props = Omit<ComponentProps<typeof InventoryTable>, "photoThumbnails"> & { photoRegistrationEnabled: boolean };

/** Text and existing inventory thumbnails render immediately. The optional Photo
 * Registration lookup can be slow for 100 rows, so it runs after first paint.
 * Ignore an older page's response when search/pagination changes mid-request. */
export function InventoryTableWithPhotos({ photoRegistrationEnabled, ...props }: Props) {
  const photos = usePrimaryPhotoThumbnails(props.rows.map(row => row.id), photoRegistrationEnabled);
  return <InventoryTable {...props} photoThumbnails={photos} />;
}
