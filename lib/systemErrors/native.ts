type NativeHandler = (error: unknown, fatal?: boolean) => void;
export type NativeErrorUtils = { getGlobalHandler: () => NativeHandler; setGlobalHandler: (handler: NativeHandler) => void };
/** Preserve React Native's exception handling; reporting never suppresses a crash. */
export function monitorNativeErrors(report: (error: unknown) => Promise<unknown>, utils?: NativeErrorUtils): () => void {
  if (!utils || typeof utils.getGlobalHandler !== 'function' || typeof utils.setGlobalHandler !== 'function') return () => {};
  const previous = utils.getGlobalHandler();
  if (typeof previous !== 'function') return () => {};
  const handler: NativeHandler = (error, fatal) => {
    try { void Promise.resolve(report(error)).catch(() => undefined); } catch { /* Reporting must not replace native handling. */ }
    previous(error, fatal);
  };
  utils.setGlobalHandler(handler);
  return () => { if (utils.getGlobalHandler() === handler) utils.setGlobalHandler(previous); };
}
