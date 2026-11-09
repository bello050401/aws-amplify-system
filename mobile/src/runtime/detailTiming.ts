/** Opt-in, local console durations only. Never log a product, user, URL or token. */
export function detailTiming(label: 'request' | 'screen') {
  const enabled = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('editTiming') === '1';
  const started = Date.now();
  let previous = started;
  return (phase: 'authenticated' | 'response' | 'online' | 'loaded' | 'ready') => {
    if (!enabled) return;
    const now = Date.now();
    console.info('[BELLO edit timing]', JSON.stringify({label,phase,elapsedMs:now-started,stageMs:now-previous}));
    previous = now;
  };
}
