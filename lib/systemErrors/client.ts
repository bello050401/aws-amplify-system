import { normalizeSystemErrorSignal, type SystemErrorSignal } from './contract';

export type SystemErrorReporter = (signal: SystemErrorSignal) => Promise<boolean>;
/** Only fixed labels enter this transport. Error objects, messages and URLs do not. */
export function createSystemErrorReporter(options: {
  url: string;
  fetcher?: typeof fetch;
  headers?: () => Promise<Record<string, string>>;
  online?: () => boolean;
  now?: () => number;
  timeoutMs?: number;
}): SystemErrorReporter {
  const now = options.now ?? Date.now;
  const recent = new Map<string, number>();
  const pending = new Map<string, Promise<boolean>>();
  let budgetStart = now(), attempts = 0;
  return (input) => {
    const safe = normalizeSystemErrorSignal(input);
    if (!safe || options.online?.() === false) return Promise.resolve(false);
    const time = now(), key = JSON.stringify(safe);
    if (pending.has(key)) return pending.get(key)!;
    if (time - budgetStart >= 3_600_000 || time < budgetStart) { budgetStart = time; attempts = 0; recent.clear(); }
    for (const [id, until] of recent) if (until <= time) recent.delete(id);
    if (recent.has(key) || attempts >= 20) return Promise.resolve(false);
    attempts++;
    recent.set(key, time + 30_000);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve(false); }, options.timeoutMs ?? 4000);
    });
    const send = (async () => {
      try {
        const extraHeaders = options.headers ? await options.headers() : {};
        if (controller.signal.aborted) return false;
        const response = await (options.fetcher ?? fetch)(options.url, {
          method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
          headers: { ...extraHeaders, 'Content-Type': 'application/json', 'X-Bello-Error-Report': '1' },
          body: JSON.stringify(safe), signal: controller.signal,
        });
        if (controller.signal.aborted || response.status !== 202) return false;
        recent.set(key, now() + 300_000);
        return true;
      } catch { return false; }
    })();
    const work = Promise.race([send, deadline]).finally(() => clearTimeout(timer));
    pending.set(key, work);
    void work.finally(() => pending.delete(key));
    return work;
  };
}

let browserReporter: SystemErrorReporter | null = null;
export function reportSystemError(signal: SystemErrorSignal): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  browserReporter ??= createSystemErrorReporter({ url: '/api/system-errors', online: () => navigator.onLine !== false });
  return browserReporter(signal);
}
export function safeErrorClass(error: unknown): NonNullable<SystemErrorSignal['errorClass']> {
  const name = error instanceof Error ? error.name : '';
  return ['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'].includes(name)
    ? name as NonNullable<SystemErrorSignal['errorClass']> : 'Unknown';
}
export function safeErrorDigest(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const digest = (error as { digest?: unknown }).digest;
  return typeof digest === 'string' && /^\d{1,20}$/.test(digest) ? digest : undefined;
}
/** A closed vocabulary, not the actual URL (which may contain inventory IDs). */
export function errorComponent(path: string): SystemErrorSignal['component'] {
  const clean = path.split(/[?#]/, 1)[0];
  if (clean.startsWith('/staff-app') || clean.startsWith('/api/mobile/')) return 'staff-app';
  if (clean === '/inventory' || clean.startsWith('/inventory/') || clean.startsWith('/api/inventory/')) return 'inventory';
  return 'app';
}
function ordinaryCancellation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError' || (error.name === 'TypeError' && /^(?:Failed to fetch|Load failed|Network request failed)$/.test(error.message));
}
/** Installs no timers, forwards no response bodies, and restores the original fetch. */
export function monitorBrowserErrors(report: SystemErrorReporter = reportSystemError, options: { observeFetch?: boolean } = {}): () => void {
  if (typeof window === 'undefined') return () => {};
  const component = () => errorComponent(window.location.pathname);
  const safelyReport = (signal: SystemErrorSignal) => {
    try { void Promise.resolve(report(signal)).catch(() => false); } catch { /* Never report reporting failures. */ }
  };
  const runtime = (error: unknown) => {
    if (navigator.onLine === false || ordinaryCancellation(error)) return;
    safelyReport({ code: 'UI_UNHANDLED', surface: 'web', component: component(), operation: 'render', errorClass: safeErrorClass(error) });
  };
  const onError = (event: ErrorEvent) => {
    if (!event.error) return;
    if (event.filename) { try { if (new URL(event.filename, window.location.href).origin !== window.location.origin) return; } catch { return; } }
    runtime(event.error);
  };
  const onRejection = (event: PromiseRejectionEvent) => runtime(event.reason);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  const original = window.fetch;
  const wrapped: typeof fetch = async (...args) => {
    const response = await original(args[0], args[1]);
    try {
      const input = args[0], raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, window.location.href);
      if (response.status >= 500 && url.origin === window.location.origin &&
          !['/api/mobile/config', '/api/mobile/session', '/api/inventory/health', '/inventory/login'].some(path => url.pathname === path || url.pathname.startsWith(path + '/')) &&
          (url.pathname.startsWith('/api/inventory/') || url.pathname.startsWith('/api/mobile/') || url.pathname === '/inventory' || url.pathname.startsWith('/inventory/'))) {
        safelyReport({ code: 'API_SERVER_ERROR', surface: 'web', component: errorComponent(url.pathname), operation: 'request' });
      }
    } catch { /* Observability cannot affect the original request or response. */ }
    return response;
  };
  if (options.observeFetch !== false) window.fetch = wrapped;
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    if (window.fetch === wrapped) window.fetch = original;
  };
}
