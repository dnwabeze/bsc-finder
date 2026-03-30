import {
  Connection,
  PublicKey,
  VersionedTransactionResponse,
} from '@solana/web3.js';
import { PROGRAMS } from '../config';
import { fetchMetadata } from '../parsers/metadata';
import { TokenInfo, passesFilters } from '../filters/tokenFilter';
import { sendTokenAlert } from '../notifiers/telegram';
import { addToWatchlist } from '../watchlist/watchlist';
import { enrichWithSupply } from '../filters/fetchSupply';
import { rateLimit } from '../utils/rateLimiter';
import { fetchMetaplexMetadataForMint } from './metaplexHelper';

const RAYDIUM_AMM_ID = new PublicKey(PROGRAMS.RAYDIUM_AMM);
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const KNOWN_QUOTE = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);

const processedSignatures = new Set<string>();

export function startRaydiumMonitor(connection: Connection): void {
  console.log('[Raydium] Starting monitor...');

  const subId = connection.onLogs(
    RAYDIUM_AMM_ID,
    async (logs) => {
      if (logs.err) return;
      const isInit = logs.logs.some(l => l.includes('initialize2') || l.includes('Initialize'));
      if (!isInit) return;
      await processSignature(connection, logs.signature);
    },
    'confirmed'
  );

  console.log(`[Raydium] Subscribed AMM (subId=${subId})`);
}

async function processSignature(connection: Connection, signature: string): Promise<void> {
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

    const poolInfo = extractRaydiumPool(tx);
    if (!poolInfo) return;

    if (KNOWN_QUOTE.has(poolInfo.baseMint) && KNOWN_QUOTE.has(poolInfo.quoteMint)) return;

    const newTokenMint = KNOWN_QUOTE.has(poolInfo.baseMint)
      ? poolInfo.quoteMint
      : poolInfo.baseMint;

    console.log(`[Raydium] New pool — token: ${newTokenMint}`);

    const token: TokenInfo = {
      mint: newTokenMint,
      name: 'Unknown',
      symbol: 'Unknown',
      source: 'raydium',
      creator: poolInfo.creator,
      signature,
      timestamp: Date.now(),
    };

    const onchain = await fetchMetaplexMetadataForMint(connection, newTokenMint);
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
      console.log(`[Raydium] Filtered out: ${token.symbol}`);
      return;
    }

    if (!addToWatchlist(token)) return;
    await sendTokenAlert(token);

  } catch (err: any) {
    console.error('[Raydium] Error:', err?.message);
  }
}

function extractRaydiumPool(tx: VersionedTransactionResponse): {
  baseMint: string; quoteMint: string; creator?: string;
} | null {
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

    const instructions = msg.compiledInstructions || (msg as any).instructions || [];
    for (const ix of instructions) {
      const prog = accounts[ix.programIdIndex];
      if (prog !== PROGRAMS.RAYDIUM_AMM) continue;

      const data: Buffer = Buffer.from(ix.data);
      if (data.length === 0 || data[0] !== 1) continue; // initialize2 = 1

      const ixAccounts = (ix.accountKeyIndexes || ix.accounts || []).map(
        (idx: number) => accounts[idx]
      );
      const baseMint  = ixAccounts[4];
      const quoteMint = ixAccounts[5];
      const creator   = accounts[0];
      if (!baseMint || !quoteMint) return null;
      return { baseMint, quoteMint, creator };
    }
    return null;
  } catch {
    return null;
  }
}
