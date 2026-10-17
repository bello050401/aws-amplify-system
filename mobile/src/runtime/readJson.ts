export class ReadHttpError extends Error {
  constructor(public readonly status: number) { super(`Read failed (${status})`); }
}

/** Only GETs are retried. Saves/uploads/deletions must never use this helper. */
export async function readJson(url: string, init: Pick<RequestInit, "headers" | "credentials" | "redirect">, options: {
  retry?: boolean; timeoutMs?: number; fetcher?: typeof fetch; retryDelayMs?: number;
} = {}): Promise<unknown> {
  const fetcher = options.fetcher ?? fetch;
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20000);
    try {
      const response = await fetcher(url, { ...init, method: "GET", cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new ReadHttpError(response.status);
      return await response.json();
    } catch (error) {
      const transient = error instanceof ReadHttpError ? [408, 502, 503, 504].includes(error.status)
        : error instanceof Error && ["TypeError", "AbortError"].includes(error.name);
      if (!options.retry || attempt !== 0 || !transient) throw error;
    } finally { clearTimeout(timer); }
    await new Promise(resolve => setTimeout(resolve, options.retryDelayMs ?? 300));
  }
}
