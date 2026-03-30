import {
  Connection,
  PublicKey,
  KeyedAccountInfo,
} from '@solana/web3.js';
import { PROGRAMS } from '../config';
import { fetchMetadata } from '../parsers/metadata';
import { TokenInfo, passesFilters } from '../filters/tokenFilter';
import { sendTokenAlert } from '../notifiers/telegram';
import { addToWatchlist } from '../watchlist/watchlist';
import { enrichWithSupply } from '../filters/fetchSupply';
import { rateLimit } from '../utils/rateLimiter';
import { fetchMetaplexMetadataForMint } from './metaplexHelper';

const TOKEN_PROGRAM_ID = new PublicKey(PROGRAMS.TOKEN_PROGRAM);
const TOKEN_2022_ID    = new PublicKey(PROGRAMS.TOKEN_2022_PROGRAM);

// Track seen mints so we don't re-process the same mint if it's updated later
const seenMints = new Set<string>();

// SPL Token mint layout (82 bytes):
//   0-35:  mint_authority (COption<Pubkey>)
//   36-43: supply (u64)
//   44:    decimals (u8)   ← NOT is_initialized
//   45:    is_initialized (bool)
//   46-81: freeze_authority (COption<Pubkey>)
const MINT_IS_INITIALIZED_OFFSET = 45;

// base58(Buffer.from([1])) === '2' — used for memcmp RPC filter
const IS_INITIALIZED_B58 = '2';

export function startTraditionalMonitor(connection: Connection): void {
  console.log('[Traditional] Starting SPL Token monitor...');

  // SPL Token: all mints are exactly 82 bytes
  subscribeBySize(connection, TOKEN_PROGRAM_ID, 'SPL Token', 82);

  // Token-2022 without extensions: 82 bytes
  subscribeBySize(connection, TOKEN_2022_ID, 'Token-2022', 82);

  // Token-2022 WITH extensions: size > 82 bytes — use is_initialized memcmp instead.
  // Token accounts are 165+ bytes; this subscription also catches those, so we
  // guard against them below by checking that size < 165 or by the seenMints set.
  subscribeByInitialized(connection, TOKEN_2022_ID, 'Token-2022 (extended)');
}

function subscribeBySize(
  connection: Connection,
  programId: PublicKey,
  label: string,
  dataSize: number,
): void {
  const subId = connection.onProgramAccountChange(
    programId,
    async (keyedAccountInfo: KeyedAccountInfo) => {
      const data = keyedAccountInfo.accountInfo.data;
      if (data[MINT_IS_INITIALIZED_OFFSET] !== 1) return; // is_initialized must be true
      await handleMintAccount(connection, keyedAccountInfo, label);
    },
    'confirmed',
    [{ dataSize }],
  );
  console.log(`[Traditional] Subscribed to ${label} (${dataSize}B mints, subId=${subId})`);
}

function subscribeByInitialized(
  connection: Connection,
  programId: PublicKey,
  label: string,
): void {
  // Catches Token-2022 mints that have extensions and are therefore > 82 bytes.
  // Filter: is_initialized byte (offset 44) === 1, AND skip 82-byte accounts
  // (already covered by subscribeBySize) and 165-byte token accounts.
  const subId = connection.onProgramAccountChange(
    programId,
    async (keyedAccountInfo: KeyedAccountInfo) => {
      const size = keyedAccountInfo.accountInfo.data.length;
      if (size === 82 || size === 165) return; // handled elsewhere or token account
      await handleMintAccount(connection, keyedAccountInfo, label);
    },
    'confirmed',
    [{ memcmp: { offset: MINT_IS_INITIALIZED_OFFSET, bytes: IS_INITIALIZED_B58 } }],
  );
  console.log(`[Traditional] Subscribed to ${label} (extended mints, subId=${subId})`);
}

async function handleMintAccount(
  connection: Connection,
  keyedAccountInfo: KeyedAccountInfo,
  label: string,
): Promise<void> {
  const mint = keyedAccountInfo.accountId.toBase58();

  // Skip mints we've already processed (e.g. subsequent setAuthority calls)
  if (seenMints.has(mint)) return;
  seenMints.add(mint);
  if (seenMints.size > 50000) {
    const first = seenMints.values().next().value;
    if (first) seenMints.delete(first);
  }

  await processMint(connection, mint, label);
}

async function processMint(
  connection: Connection,
  mint: string,
  label: string,
): Promise<void> {
  try {
    console.log(`[Traditional] New mint detected: ${mint}`);

    // Get creation signature and creator from the first tx for this mint
    let signature = '';
    let creator: string | undefined;

    try {
      const sigs = await rateLimit(() =>
        connection.getSignaturesForAddress(new PublicKey(mint), { limit: 1 }, 'confirmed')
      );
      if (sigs.length > 0) {
        signature = sigs[0].signature;
        // Fetch tx only to extract the fee-payer (creator)
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
    } catch { /* non-fatal — proceed without signature/creator */ }

    const token: TokenInfo = {
      mint,
      name: 'Unknown',
      symbol: 'Unknown',
      source: 'traditional',
      creator,
      signature,
      timestamp: Date.now(),
    };

    // Retry metadata fetch up to 3 times with a delay.
    // Metaplex metadata is often in a separate transaction that confirms
    // slightly after the mint — without retries the name stays "Unknown"
    // and gets dropped by name keyword filters.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 4000));

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

      // Stop retrying once we have a real name
      if (token.name !== 'Unknown' && token.name !== '') break;
    }

    await enrichWithSupply(connection, token);

    if (!passesFilters(token)) {
      console.log(`[Traditional] Filtered out: ${token.symbol}`);
      return;
    }

    if (!addToWatchlist(token)) return; // Metaplex monitor already claimed this token
    await sendTokenAlert(token);

  } catch (err: any) {
    console.error('[Traditional] Error processing mint:', err?.message);
  }
}
