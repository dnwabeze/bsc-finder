/**
 * Generic Launchpad Monitor
 *
 * Watches known launchpad program IDs (Moonshot, Boop, Meteora, etc.)
 * and any custom ones configured in CUSTOM_LAUNCHPAD_PROGRAMS.
 *
 * Since each launchpad has a different instruction layout, we rely on:
 * 1. Detecting new token mints created within the transaction
 * 2. Fetching Metaplex metadata for name/symbol/uri
 * 3. Fetching socials from the URI
 */

import { Connection, PublicKey, VersionedTransactionResponse } from '@solana/web3.js';
import { PROGRAMS } from '../config';
import { fetchMetadata } from '../parsers/metadata';
import { TokenInfo, passesFilters } from '../filters/tokenFilter';
import { sendTokenAlert } from '../notifiers/telegram';
import { addToWatchlist } from '../watchlist/watchlist';
import { enrichWithSupply } from '../filters/fetchSupply';
import { rateLimit } from '../utils/rateLimiter';
import { fetchMetaplexMetadataForMint } from './metaplexHelper';

// ── Known launchpad program IDs ──────────────────────────────────────────────
export const KNOWN_LAUNCHPADS: Record<string, string> = {
  'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG':  'Moonshot',
  'LanMV9sAd7wArD4vJFi88ypZtwNjzCuZSMDzBFAYKnU':  'Meteora Launchpad',
  'boopkpWqe68MSxLqBGogs626rFR4nMCbFfeTxB7fBEk':  'Boop.fun',
  'BooMfmSvikMZiAbWKfWfELB3GGfHnbZnSGQsEJXjhKz':  'Bonk.fun',
  'BELiEVEGmpToou59eSvgYM8n6Xnz5bBZe2LvV2LzJsK':  'Believe.app',
  // Jupiter removed — it's a DEX aggregator, not a launchpad (too much volume)
};

const TOKEN_PROGRAM   = PROGRAMS.TOKEN_PROGRAM;
const TOKEN_2022      = PROGRAMS.TOKEN_2022_PROGRAM;

export function startLaunchpadMonitors(connection: Connection): void {
  // Get custom launchpad IDs from env
  const custom = (process.env.CUSTOM_LAUNCHPAD_PROGRAMS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  custom.forEach(pid => {
    KNOWN_LAUNCHPADS[pid] = 'Custom Launchpad';
  });

  const launchpadIds = Object.keys(KNOWN_LAUNCHPADS);

  if (launchpadIds.length === 0) {
    console.log('[Launchpads] No additional launchpads configured');
    return;
  }

  for (const programId of launchpadIds) {
    const label = KNOWN_LAUNCHPADS[programId];
    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(programId);
    } catch {
      console.warn(`[Launchpads] Invalid program ID: ${programId}`);
      continue;
    }

    const subId = connection.onLogs(
      pubkey,
      async (logs) => {
        if (logs.err) return;
        await processLaunchpadSignature(connection, logs.signature, programId, label);
      },
      'confirmed'
    );

    console.log(`[Launchpads] Subscribed to ${label} (subId=${subId})`);
  }
}

const processedSignatures = new Set<string>();

async function processLaunchpadSignature(
  connection: Connection,
  signature: string,
  programId: string,
  label: string
): Promise<void> {
  if (processedSignatures.has(signature)) return;
  processedSignatures.add(signature);

  if (processedSignatures.size > 10000) {
    const first = processedSignatures.values().next().value;
    if (first) processedSignatures.delete(first);
  }

  try {
    const tx = await rateLimit(() => connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    }));
    if (!tx) return;

    // Detect newly initialized mints in the tx by inspecting inner instructions
    const newMints = extractNewMintsFromTx(tx);
    if (newMints.length === 0) return;

    for (const mint of newMints) {
      console.log(`[${label}] New token mint: ${mint}`);

      const token: TokenInfo = {
        mint,
        name: 'Unknown',
        symbol: 'Unknown',
        source: 'traditional',
        creator: extractCreator(tx),
        signature,
        timestamp: Date.now(),
        launchpad: label,
      };

      const onchain = await fetchMetaplexMetadataForMint(connection, mint);
      if (onchain) {
        token.name   = onchain.name   || token.name;
        token.symbol = onchain.symbol || token.symbol;
        if (onchain.uri) {
          token.metadata = await fetchMetadata(onchain.uri);
          if (token.metadata.name)   token.name   = token.metadata.name;
          if (token.metadata.symbol) token.symbol = token.metadata.symbol;
        }
      }

      await enrichWithSupply(connection, token);

      if (!passesFilters(token)) {
        console.log(`[${label}] Filtered out: ${token.symbol}`);
        continue;
      }

      await sendTokenAlert(token);
      addToWatchlist(token);
    }
  } catch (err: any) {
    console.error(`[${label}] Error:`, err?.message);
  }
}

function extractNewMintsFromTx(tx: VersionedTransactionResponse): string[] {
  const mints: string[] = [];
  try {
    const msg = tx.transaction.message;
    const accounts: string[] = [];

    if ('staticAccountKeys' in msg) {
      msg.staticAccountKeys.forEach(k => accounts.push(k.toBase58()));
    } else if ('accountKeys' in msg) {
      (msg as any).accountKeys.forEach((k: any) =>
        accounts.push(k.toBase58 ? k.toBase58() : k)
      );
    }
    if (tx.meta?.loadedAddresses) {
      tx.meta.loadedAddresses.writable.forEach(k => accounts.push(k.toBase58()));
      tx.meta.loadedAddresses.readonly.forEach(k => accounts.push(k.toBase58()));
    }

    const allInstructions = [
      ...(msg.compiledInstructions || (msg as any).instructions || []),
      // Also check inner instructions
      ...((tx.meta?.innerInstructions || []).flatMap((ii: any) => ii.instructions || [])),
    ];

    for (const ix of allInstructions) {
      const progIdx = ix.programIdIndex;
      const prog = accounts[progIdx];
      if (prog !== TOKEN_PROGRAM && prog !== TOKEN_2022) continue;

      const data: Buffer = Buffer.from(ix.data);
      if (data.length === 0) continue;

      // InitializeMint = 0, InitializeMint2 = 20
      if (data[0] !== 0 && data[0] !== 20) continue;

      const ixAccounts = (ix.accountKeyIndexes || ix.accounts || []).map(
        (idx: number) => accounts[idx]
      );
      const mint = ixAccounts[0];
      if (mint && !mints.includes(mint)) mints.push(mint);
    }
  } catch {}

  return mints;
}

function extractCreator(tx: VersionedTransactionResponse): string | undefined {
  try {
    const msg = tx.transaction.message;
    if ('staticAccountKeys' in msg) {
      return msg.staticAccountKeys[0]?.toBase58();
    }
    const keys = (msg as any).accountKeys;
    if (keys && keys[0]) {
      return keys[0].toBase58 ? keys[0].toBase58() : keys[0];
    }
  } catch {}
  return undefined;
}
