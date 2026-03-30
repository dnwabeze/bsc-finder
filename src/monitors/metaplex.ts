/**
 * Metaplex Metadata Monitor
 *
 * Watches the Metaplex Token Metadata program for new metadata accounts.
 * This is more reliable than watching the SPL Token program because:
 *   - We get name, symbol, and URI directly from the metadata account
 *   - No retry needed — metadata is already present when this fires
 *   - Works for any platform: solcreate.app, CLI, launchpads, etc.
 *
 * NFT filtering: NFTs have decimals=0 and supply=1. We skip those.
 */

import { Connection, PublicKey, KeyedAccountInfo } from '@solana/web3.js';
import { PROGRAMS } from '../config';
import { fetchMetadata } from '../parsers/metadata';
import { TokenInfo, passesFilters } from '../filters/tokenFilter';
import { sendTokenAlert } from '../notifiers/telegram';
import { addToWatchlist } from '../watchlist/watchlist';
import { rateLimit } from '../utils/rateLimiter';

const METAPLEX_PROGRAM = new PublicKey(PROGRAMS.METAPLEX_PROGRAM);

// Metaplex account key byte values:
//   4 = MetadataV1  ← what we want
//   6 = MasterEditionV2
//   7 = EditionV1
// base58([4]) = '5'
const METADATA_V1_KEY_B58 = '5';

// Metaplex metadata account layout:
//   0:     key (u8)
//   1-32:  update_authority (Pubkey)
//   33-64: mint (Pubkey)
//   65+:   name (string), symbol (string), uri (string) ...
const MINT_OFFSET = 33;

const seenMints = new Set<string>();

export function startMetaplexMonitor(connection: Connection): void {
  const subId = connection.onProgramAccountChange(
    METAPLEX_PROGRAM,
    async (keyedAccountInfo: KeyedAccountInfo) => {
      await handleMetadataAccount(connection, keyedAccountInfo);
    },
    'confirmed',
    [{ memcmp: { offset: 0, bytes: METADATA_V1_KEY_B58 } }],
  );
  console.log(`[Metaplex] Subscribed to token metadata creations (subId=${subId})`);
}

async function handleMetadataAccount(
  connection: Connection,
  keyedAccountInfo: KeyedAccountInfo,
): Promise<void> {
  try {
    const data = keyedAccountInfo.accountInfo.data;
    if (data.length < 100) return;

    // Extract mint address from account data
    const mint = new PublicKey(data.slice(MINT_OFFSET, MINT_OFFSET + 32)).toBase58();

    // Parse name, symbol, uri directly from account data — no extra RPC call needed
    const parsed = parseStrings(data, 65);
    if (!parsed) return;

    // If name AND symbol are both empty, the account was allocated but not yet written.
    // Don't deduplicate yet — the next event will carry the actual data.
    if (!parsed.name && !parsed.symbol) return;

    // Deduplicate — skip if already processed or alerted via another monitor
    if (seenMints.has(mint)) return;
    seenMints.add(mint);
    if (seenMints.size > 50000) {
      const first = seenMints.values().next().value;
      if (first) seenMints.delete(first);
    }

    console.log(`[Metaplex] New metadata: ${parsed.symbol || '?'} | ${mint}`);

    // ── Early filter check ───────────────────────────────────────────────────
    // Run a pre-check using on-chain name/symbol BEFORE making any RPC calls.
    // This avoids wasting supply/signature fetches on tokens that won't match.
    const preToken: TokenInfo = {
      mint,
      name:      parsed.name   || 'Unknown',
      symbol:    parsed.symbol || 'Unknown',
      source:    'traditional',
      signature: '',
      timestamp: Date.now(),
    };
    if (!passesFilters(preToken)) {
      console.log(`[Metaplex] Filtered out: ${preToken.symbol}`);
      return;
    }

    // ── Passed filter — now fetch supply, signature, off-chain metadata ──────
    let supplyInfo;
    try {
      supplyInfo = await rateLimit(() =>
        connection.getTokenSupply(new PublicKey(mint), 'confirmed')
      );
    } catch {
      return; // mint not ready yet — skip
    }

    const decimals = supplyInfo.value.decimals;
    const supply   = BigInt(supplyInfo.value.amount);

    // Skip NFTs: decimals=0 and supply=1
    if (decimals === 0 && supply === BigInt(1)) {
      return;
    }

    // Get creator from first tx for this mint
    let signature = '';
    let creator: string | undefined;
    try {
      const sigs = await rateLimit(() =>
        connection.getSignaturesForAddress(new PublicKey(mint), { limit: 1 }, 'confirmed')
      );
      if (sigs.length > 0) {
        signature = sigs[0].signature;
        const tx = await rateLimit(() => connection.getTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        }));
        if (tx) {
          const msg = tx.transaction.message;
          if ('staticAccountKeys' in msg) {
            creator = msg.staticAccountKeys[0]?.toBase58();
          } else {
            const keys = (msg as any).accountKeys;
            creator = keys?.[0]?.toBase58?.() ?? keys?.[0];
          }
        }
      }
    } catch { /* non-fatal */ }

    const token: TokenInfo = {
      mint,
      name:     parsed.name   || 'Unknown',
      symbol:   parsed.symbol || 'Unknown',
      source:   'traditional',
      creator,
      signature,
      timestamp: Date.now(),
      supply,
      decimals,
    };

    // Fetch off-chain metadata (image, socials, description) if URI present
    if (parsed.uri) {
      try {
        token.metadata = await fetchMetadata(parsed.uri);
        if (token.metadata.name)   token.name   = token.metadata.name;
        if (token.metadata.symbol) token.symbol = token.metadata.symbol;
      } catch { /* non-fatal */ }
    }

    // Claim the mint before awaiting sendTokenAlert — prevents duplicate alerts
    // if Traditional monitor also detects this token concurrently
    if (!addToWatchlist(token)) return;
    await sendTokenAlert(token);

  } catch (err: any) {
    console.error('[Metaplex] Error:', err?.message);
  }
}

function parseStrings(
  data: Buffer,
  startOffset: number,
): { name: string; symbol: string; uri: string } | null {
  try {
    let offset = startOffset;

    const readString = (): string => {
      if (offset + 4 > data.length) return '';
      const len = data.readUInt32LE(offset);
      offset += 4;
      if (len > 500 || offset + len > data.length) return '';
      const str = data.slice(offset, offset + len).toString('utf-8').replace(/\0/g, '').trim();
      offset += len;
      return str;
    };

    const name   = readString();
    const symbol = readString();
    const uri    = readString();

    return { name, symbol, uri };
  } catch {
    return null;
  }
}
