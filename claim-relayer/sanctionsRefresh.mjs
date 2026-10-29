export const SANCTIONS_REFRESH_EVERY_MS = 12 * 60 * 60 * 1000;

/**
 * Calls sanctions.refresh at start and on a fixed interval.
 * The default interval is 12 hours. Tests pass setInterval.
 */
export function startSanctionsRefresh(sanctions, options = {}) {
  const intervalMs = options.intervalMs ?? SANCTIONS_REFRESH_EVERY_MS;
  const fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis);
  const schedule = options.setInterval || setInterval;
  const cancel = options.clearInterval || clearInterval;
  let running = false;
  let inflight = Promise.resolve();

  function tick() {
    if (running) return inflight;
    running = true;
    inflight = Promise.resolve()
      .then(() => sanctions.refresh(fetchImpl))
      .catch(() => {})
      .finally(() => {
        running = false;
      });
    return inflight;
  }

  const started = tick();
  const handle = schedule(() => {
    tick();
  }, intervalMs);
  if (handle && typeof handle.unref === "function") handle.unref();
  return {
    started,
    intervalMs,
    stop() {
      cancel(handle);
      return inflight;
    },
  };
}
