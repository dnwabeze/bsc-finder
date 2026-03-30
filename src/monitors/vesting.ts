/**
 * Vesting Platform Monitor
 *
 * Watches known token-vesting programs for new lock/stream transactions.
 * When a vesting contract is created whose token supply matches your
 * FILTER_EXACT_SUPPLY target (±1%), an alert fires immediately.
 *
 * This catches the CA at the moment team/investor tokens are being locked —
 * which typically happens right before or right at launch.
 *
 * Supported platforms (built-in):
 *   - Streamflow Finance  (strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m)
 *   - Streamflow v2       (HqDGZeco9pJE83ozoeLHHRtWkHCWRDVnHFpuJMNWMH7q)
 *   - Magnus              (MLnmQ5SFd7yoFU47k8JZhE5nEcpLNqVqiFiKqFvkKkH)  [configurable]
 *
 * Add any additional programs via VESTING_PROGRAMS=programId1,programId2
 */

import { Connection, PublicKey, Logs, ParsedTransactionWithMeta } from '@solana/web3.js';
import { config } from '../config';
import { sendVestingAlert } from '../notifiers/telegram';

// Known vesting program IDs — always watched
const BUILTIN_VESTING_PROGRAMS = [
  'strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m', // Streamflow Finance (vesting/stream)
  'MErKy6nZVoVAkryxAejJz2juifQ4ArgLgHmaJCQkU7N', // Streamflow Distributor (airdrops)
  'CChTq6PthWU82YZkbveA3WDf7s97BWhBK4Vx9bmsT743', // Bonfida Token Vesting
  'LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn', // Jupiter Lock
  'SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu',  // Squads v3 (multisig)
  'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf',  // Squads v4 (multisig)
];

export const VESTING_PROGRAM_NAMES: Record<string, string> = {
  'strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m': 'Streamflow Finance',
  'MErKy6nZVoVAkryxAejJz2juifQ4ArgLgHmaJCQkU7N': 'Streamflow Distributor',
  'CChTq6PthWU82YZkbveA3WDf7s97BWhBK4Vx9bmsT743': 'Bonfida Token Vesting',
  'LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn': 'Jupiter Lock',
  'SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu':  'Squads v3',
  'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf':  'Squads v4',
};

const seen = new Set<string>();

export function startVestingMonitor(connection: Connection): void {
  const extraPrograms = config.vesting.extraPrograms;
  const allPrograms   = [...new Set([...BUILTIN_VESTING_PROGRAMS, ...extraPrograms])];

  if (!config.vesting.exactSupply && config.filters.minSupply === null && config.filters.maxSupply === null) {
    console.log('[Vesting] ⚠️  No supply filter set — vesting monitor will alert on ALL vesting txs. Set FILTER_EXACT_SUPPLY for precision.');
  }

  console.log(`[Vesting] Watching ${allPrograms.length} vesting program(s):`);
  allPrograms.forEach(p => console.log(`  • ${VESTING_PROGRAM_NAMES[p] ?? p}`));

  for (const programId of allPrograms) {
    connection.onLogs(
      new PublicKey(programId),
      (logs: Logs) => handleLogs(connection, logs, programId),
      'confirmed'
    );
  }
}

async function handleLogs(
  connection: Connection,
  logs: Logs,
  programId: string
): Promise<void> {
  if (logs.err) return;
  if (seen.has(logs.signature)) return;
  seen.add(logs.signature);
  if (seen.size > 10_000) {
    seen.delete(seen.values().next().value!);
  }

  let tx: ParsedTransactionWithMeta | null = null;
  try {
    tx = await connection.getParsedTransaction(logs.signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
  } catch {
    return;
  }
  if (!tx) return;

  // Collect every unique mint referenced anywhere in the transaction
  const mints = extractMints(tx);
  for (const mint of mints) {
    await checkMint(connection, mint, logs.signature, programId);
  }
}

/**
 * Walk all parsed instructions (top-level + inner) and collect mint addresses.
 */
function extractMints(tx: ParsedTransactionWithMeta): Set<string> {
  const mints = new Set<string>();

  const visitIx = (ix: any) => {
    if (!('parsed' in ix)) return;
    const info = ix.parsed?.info;
    if (!info) return;
    if (info.mint)        mints.add(info.mint);
    if (info.mintAddress) mints.add(info.mintAddress);
  };

  for (const ix of tx.transaction.message.instructions) visitIx(ix);
  for (const inner of tx.meta?.innerInstructions ?? []) {
    for (const ix of inner.instructions) visitIx(ix);
  }

  return mints;
}

async function checkMint(
  connection: Connection,
  mint: string,
  signature: string,
  programId: string
): Promise<void> {
  try {
    const supplyInfo  = await connection.getTokenSupply(new PublicKey(mint), 'confirmed');
    const supplyHuman = Number(supplyInfo.value.amount) / Math.pow(10, supplyInfo.value.decimals);

    if (!supplyMatchesTarget(supplyHuman)) return;

    const platformName = VESTING_PROGRAM_NAMES[programId] ?? programId.slice(0, 16) + '…';
    console.log(`[Vesting] 🚨 Supply match! Mint ${mint} supply=${supplyHuman.toLocaleString()} on ${platformName}`);
    await sendVestingAlert(mint, signature, supplyHuman, supplyInfo.value.decimals, platformName);
  } catch {
    // Mint may not be a token — ignore
  }
}

function supplyMatchesTarget(supplyHuman: number): boolean {
  const exact = config.vesting.exactSupply;
  if (exact !== null) {
    // ±1% tolerance on exact supply
    return Math.abs(supplyHuman - exact) / exact <= 0.01;
  }
  const { minSupply, maxSupply } = config.filters;
  if (minSupply === null && maxSupply === null) return true; // no filter = alert all
  if (minSupply !== null && supplyHuman < minSupply) return false;
  if (maxSupply !== null && supplyHuman > maxSupply) return false;
  return true;
}
