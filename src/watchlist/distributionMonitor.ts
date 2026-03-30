/**
 * Distribution Monitor
 *
 * Polls all watched tokens on an interval and fires:
 *   Stage 2 → when supply starts spreading to multiple wallets
 *   Stage 3 → when actual distribution matches user's DISTRIBUTION_PATTERN
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config';
import { getWatched, updateWatched, pruneWatchlist, WatchedToken } from './watchlist';
import { sendDistributionAlert, sendPatternMatchAlert } from '../notifiers/telegram';

export function startDistributionMonitor(connection: Connection): void {
  const { pollIntervalMs, stage2MinHolders } = config.distribution;

  console.log(`[Distribution] Monitor started — polling every ${pollIntervalMs / 1000}s, Stage 2 triggers at ${stage2MinHolders} holders`);

  if (config.distribution.pattern.length > 0) {
    console.log(`[Distribution] Pattern: [${config.distribution.pattern.join(', ')}]% (±${config.distribution.tolerance}%)`);
  } else {
    console.log('[Distribution] No pattern set — Stage 3 disabled');
  }

  const interval = setInterval(async () => {
    pruneWatchlist(config.distribution.watchDurationMs);
    const watched = getWatched();
    if (watched.length === 0) return;

    // Batch to avoid flooding RPC
    const batchSize = 5;
    for (let i = 0; i < watched.length; i += batchSize) {
      const batch = watched.slice(i, i + batchSize);
      await Promise.allSettled(batch.map(entry => checkToken(connection, entry)));
      if (i + batchSize < watched.length) await sleep(1000);
    }
  }, pollIntervalMs);

  interval.unref();
}

async function checkToken(connection: Connection, entry: WatchedToken): Promise<void> {
  // Skip if both stages already done
  if (entry.stage2Sent && entry.stage3Sent) return;

  const { token } = entry;

  try {
    const mintPubkey  = new PublicKey(token.mint);
    const supplyInfo  = await connection.getTokenSupply(mintPubkey, 'confirmed');
    const totalSupply = BigInt(supplyInfo.value.amount);
    const decimals    = supplyInfo.value.decimals;

    if (totalSupply === 0n) return;

    // Get top 20 holders
    const largest = await connection.getTokenLargestAccounts(mintPubkey, 'confirmed');
    const holders  = largest.value;
    const count    = holders.length;

    // Build distribution array (sorted descending by %)
    const distribution = holders.map(h => {
      const pct = Number((BigInt(h.amount) * 10000n) / totalSupply) / 100;
      return Math.round(pct * 100) / 100;
    });

    // ── Stage 2 ──────────────────────────────────────────────────────────────
    if (!entry.stage2Sent && count >= config.distribution.stage2MinHolders) {
      updateWatched(token.mint, {
        stage2Sent: true,
        lastHolderCount: count,
        lastDistribution: distribution,
      });
      console.log(`[Distribution] Stage 2 → ${token.symbol} has ${count} holders`);
      await sendDistributionAlert(token, distribution, count, totalSupply, decimals);
    }

    // ── Stage 3 ──────────────────────────────────────────────────────────────
    if (!entry.stage3Sent && config.distribution.pattern.length > 0) {
      if (matchesPattern(distribution, config.distribution.pattern, config.distribution.tolerance)) {
        updateWatched(token.mint, { stage3Sent: true });
        console.log(`[Distribution] Stage 3 → ${token.symbol} matches pattern!`);
        await sendPatternMatchAlert(token, distribution, count, totalSupply, decimals);
      }
    }

    updateWatched(token.mint, { lastHolderCount: count, lastDistribution: distribution });

  } catch {
    // Token may not be fully set up yet — ignore silently
  }
}

/**
 * Check whether each slot in `actual` is within `tolerance` % of `pattern[i]`.
 * Only checks as many slots as `pattern` specifies.
 */
function matchesPattern(actual: number[], pattern: number[], tolerance: number): boolean {
  if (actual.length < pattern.length) return false;
  return pattern.every((target, i) => Math.abs(actual[i] - target) <= tolerance);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
