/** Coalesce simultaneous work, never cache an authorization decision after completion. */
export function singleFlight<T>(run: () => Promise<T>) {
  let pending: Promise<T> | undefined;
  let generation = 0;
  return {
    run(): Promise<T> {
      if (pending) return pending;
      const started = generation;
      const task = Promise.resolve().then(() => {
        if (started !== generation) throw new Error('認証状態が変更されました。');
        return run();
      }).then(value => {
        if (started !== generation) throw new Error('認証状態が変更されました。');
        return value;
      });
      pending = task;
      void task.finally(() => { if (pending === task) pending = undefined; }).catch(() => {});
      return task;
    },
    clear() { generation++; pending = undefined; },
  };
}
