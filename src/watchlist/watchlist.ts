/**
 * Watchlist
 *
 * After a token is detected and Stage 1 notification is sent,
 * it is added here. The distribution monitor polls all watched
 * tokens and fires Stage 2 + Stage 3 notifications.
 */

import { TokenInfo } from '../filters/tokenFilter';

export interface WatchedToken {
  token: TokenInfo;
  addedAt: number;
  lastHolderCount: number;
  lastDistribution: number[];   // sorted desc, as percentages e.g. [45.2, 22.1, 10.0]
  stage2Sent: boolean;          // "distribution started" notification
  stage3Sent: boolean;          // "pattern matched" notification
}

const watchlist = new Map<string, WatchedToken>();

/**
 * Add a token to the watchlist after Stage 1 fires.
 * Returns true if newly added, false if already present.
 * Use the return value to guard sendTokenAlert — prevents duplicate
 * alerts when multiple monitors (Traditional + Metaplex) detect the same mint.
 */
export function addToWatchlist(token: TokenInfo): boolean {
  if (watchlist.has(token.mint)) return false;
  watchlist.set(token.mint, {
    token,
    addedAt: Date.now(),
    lastHolderCount: 1,
    lastDistribution: [],
    stage2Sent: false,
    stage3Sent: false,
  });
  console.log(`[Watchlist] Tracking ${token.symbol} (${token.mint}) — ${watchlist.size} total`);
  return true;
}

export function getWatched(): WatchedToken[] {
  return Array.from(watchlist.values());
}

export function updateWatched(mint: string, updates: Partial<WatchedToken>): void {
  const entry = watchlist.get(mint);
  if (entry) watchlist.set(mint, { ...entry, ...updates });
}

/** Remove tokens older than maxAgeMs (default 6 hours). */
export function pruneWatchlist(maxAgeMs = 6 * 60 * 60 * 1000): void {
  const now = Date.now();
  for (const [mint, entry] of watchlist.entries()) {
    if (now - entry.addedAt > maxAgeMs) {
      watchlist.delete(mint);
      console.log(`[Watchlist] Pruned ${entry.token.symbol} (${mint})`);
    }
  }
}
