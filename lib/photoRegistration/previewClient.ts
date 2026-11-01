/** Independent, cancellable read. Photo results cannot refresh a product page
 * or hold up a later search/sale operation in Next's Server Action queue. */
export async function readPhotoPreview<T>(params: URLSearchParams, signal: AbortSignal): Promise<T> {
  const response = await fetch('/api/inventory/photo-previews?' + params.toString(), {
    credentials: 'same-origin', cache: 'no-store', signal,
  });
  if (!response.ok) throw new Error('PHOTO_PREVIEW_UNAVAILABLE');
  const result = await response.json() as {ok?: boolean; value?: T};
  if (!result.ok) throw new Error('PHOTO_PREVIEW_UNAVAILABLE');
  return result.value as T;
}
