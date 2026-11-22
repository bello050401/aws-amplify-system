import { createHash } from 'node:crypto';
import { normalizeSystemErrorSignal, type SystemErrorSignal } from './contract';

/** Same approved release and diagnostic signature share one retained incident.
 * Calendar rollover and individual users must not start another AI repair.
 * Different checks, exceptions or releases remain separate investigations. */
export function systemErrorCauseId(signal: SystemErrorSignal, release: string): string {
  const safe = normalizeSystemErrorSignal(signal);
  if (!safe || !/^(?:[a-f0-9]{7,40}|unknown)$/.test(release)) throw Error('INVALID_SIGNAL');
  return createHash('sha256').update(JSON.stringify([safe, release])).digest('hex');
}
