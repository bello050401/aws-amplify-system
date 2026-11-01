import {NextResponse} from 'next/server';
import {inventoryVerifiedReadSession} from '@/lib/inventory/mutationSession';
import {getPhotoRegistrationBadgeAction, listInventoryPrimaryPhotoThumbnailsAction} from '@/app/actions/photoRegistration';

export const dynamic = 'force-dynamic';
const headers = {'Cache-Control': 'private, no-store', Vary: 'Cookie'};

/** Background reads must not enter the client Server Action/navigation queue.
 * Reuse the existing photo permissions and selection rules after verifying the
 * caller. No mutations, cross-origin access, or persistent response cache. */
export async function GET(request: Request) {
  if (!await inventoryVerifiedReadSession()) {
    return NextResponse.json({ok: false}, {status: 401, headers});
  }
  const params = new URL(request.url).searchParams;
  try {
    if (params.get('badge') === '1' && !params.has('ids')) {
      return NextResponse.json({ok: true, value: await getPhotoRegistrationBadgeAction()}, {headers});
    }
    const ids = (params.get('ids') ?? '').split(',');
    if (params.has('badge') || ids.length > 100 || ids.some(id => !/^[a-zA-Z0-9_-]{1,100}$/.test(id))) {
      return NextResponse.json({ok: false}, {status: 400, headers});
    }
    const result = await listInventoryPrimaryPhotoThumbnailsAction([...new Set(ids)]);
    if (!result.ok) {
      const status = result.code === 'AUTH_REQUIRED' ? 401 : result.code === 'PERMISSION_DENIED' ? 403 : result.code === 'INVALID_INPUT' ? 400 : 503;
      return NextResponse.json({ok: false}, {status, headers});
    }
    return NextResponse.json(result, {headers});
  } catch {
    return NextResponse.json({ok: false}, {status: 503, headers});
  }
}
