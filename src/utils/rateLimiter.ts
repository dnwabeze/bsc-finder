/**
 * Simple rate limiter / request queue.
 * Ensures we never exceed MAX_CONCURRENT_REQUESTS at once,
 * and enforces a minimum gap between requests (MIN_INTERVAL_MS).
 */

const MAX_CONCURRENT = parseInt(process.env.RPC_MAX_CONCURRENT || '3');
const MIN_INTERVAL_MS = parseInt(process.env.RPC_MIN_INTERVAL_MS || '300');

let activeRequests = 0;
let lastRequestTime = 0;
const queue: Array<() => void> = [];

function processQueue(): void {
  if (queue.length === 0) return;
  if (activeRequests >= MAX_CONCURRENT) return;

  const now = Date.now();
  const gap = now - lastRequestTime;
  if (gap < MIN_INTERVAL_MS) {
    setTimeout(processQueue, MIN_INTERVAL_MS - gap);
    return;
  }

  const next = queue.shift();
  if (next) next();
}

export function rateLimit<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    queue.push(() => {
      activeRequests++;
      lastRequestTime = Date.now();
      fn()
        .then(resolve)
        .catch(reject)
        .finally(() => {
          activeRequests--;
          processQueue();
        });
    });
    processQueue();
  });
}
