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

const TOKEN_PROGRAM_ID = new PublicKey(PROGRAMS.TOKEN_PROGRAM);
const TOKEN_2022_ID    = new PublicKey(PROGRAMS.TOKEN_2022_PROGRAM);
const processedSignatures = new Set<string>();

export function startTraditionalMonitor(connection: Connection): void {
  console.log('[Traditional] Starting SPL Token monitor...');
  subscribeToProgram(connection, TOKEN_PROGRAM_ID, 'SPL Token',   PROGRAMS.TOKEN_PROGRAM);
  subscribeToProgram(connection, TOKEN_2022_ID,    'Token-2022', PROGRAMS.TOKEN_2022_PROGRAM);
}

function subscribeToProgram(
  connection: Connection,
  programId: PublicKey,
  label: string,
  programIdStr: string
): void {
  const subId = connection.onLogs(
    programId,
    async (logs) => {
      if (logs.err) return;
      // Pre-filter: only fetch full tx if logs mention a mint creation instruction
      // Covers all variants across SPL Token and Token-2022
      const isInitMint = logs.logs.some(l =>
        l.includes('InitializeMint') ||
        l.includes('InitializeMint2') ||
        l.includes('InitializeNonTransferableMint')
      );
      if (!isInitMint) return;
      await processSignature(connection, logs.signature, programIdStr);
    },
    'confirmed'
  );
  console.log(`[Traditional] Subscribed to ${label} (subId=${subId})`);
}

async function processSignature(
  connection: Connection,
  signature: string,
  programId: string
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

    const mintInfo = extractInitializeMint(tx, programId);
    if (!mintInfo) return;

    console.log(`[Traditional] New mint: ${mintInfo.mint}`);

    const token: TokenInfo = {
      mint: mintInfo.mint,
      name: 'Unknown',
      symbol: 'Unknown',
      source: 'traditional',
      creator: mintInfo.creator,
      signature,
      timestamp: Date.now(),
    };

    const onchain = await fetchMetaplexMetadataForMint(connection, mintInfo.mint);
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
      console.log(`[Traditional] Filtered out: ${token.symbol}`);
      return;
    }

    await sendTokenAlert(token);
    addToWatchlist(token);

  } catch (err: any) {
    console.error('[Traditional] Error:', err?.message);
  }
}

interface MintInfo { mint: string; creator?: string; }

function extractInitializeMint(
  tx: VersionedTransactionResponse,
  programId: string
): MintInfo | null {
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
      if (prog !== programId) continue;

      const data: Buffer = Buffer.from(ix.data);
      if (data.length === 0) continue;
      // 0 = InitializeMint, 20 = InitializeMint2, 40 = InitializeNonTransferableMint (Token-2022)
      if (data[0] !== 0 && data[0] !== 20 && data[0] !== 40) continue;

      const ixAccounts = (ix.accountKeyIndexes || ix.accounts || []).map(
        (idx: number) => accounts[idx]
      );
      const mint    = ixAccounts[0];
      const creator = accounts[0];
      if (!mint) return null;
      return { mint, creator };
    }
    return null;
  } catch {
    return null;
  }
}
