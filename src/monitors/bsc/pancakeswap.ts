import { ethers } from 'ethers';
import { config } from '../../config';
import { sendStatusMessage } from '../../notifiers/telegram';
import { getBnbPriceUsd } from './bnbPrice';
import { initBuyWatcher, watchPairForBuys } from './buyWatcher';

// ── Known addresses ────────────────────────────────────────────────────────────
const PANCAKESWAP_V2_FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';
const WBNB  = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const BUSD  = '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56';
const USDT  = '0x55d398326f99059fF775485246999027B3197955';

const QUOTE_TOKENS = new Set([
  WBNB.toLowerCase(),
  BUSD.toLowerCase(),
  USDT.toLowerCase(),
]);

// ── ABIs ───────────────────────────────────────────────────────────────────────
const FACTORY_ABI = [
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)',
];

const ERC20_ABI = [
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

// ── Module state ───────────────────────────────────────────────────────────────
let httpProvider: ethers.JsonRpcProvider;
let reconnecting = false;

// ── Entry point ────────────────────────────────────────────────────────────────
export function startPancakeswapMonitor(): void {
  console.log('[BSC/PancakeSwap] Starting monitor...');
  httpProvider = new ethers.JsonRpcProvider(config.bsc.rpcEndpoint);
  initBuyWatcher();
  connect();
}

// ── WebSocket connection with auto-reconnect ───────────────────────────────────
function connect(): void {
  try {
    const wsProvider = new ethers.WebSocketProvider(config.bsc.wsEndpoint);
    const factory = new ethers.Contract(PANCAKESWAP_V2_FACTORY, FACTORY_ABI, wsProvider);

    factory.on('PairCreated', async (...args: any[]) => {
      const event  = args[args.length - 1] as ethers.ContractEventPayload;
      const token0 = args[0] as string;
      const token1 = args[1] as string;
      const pair   = args[2] as string;
      try {
        await handlePairCreated(token0, token1, pair, event.log.transactionHash);
      } catch (err: any) {
        console.error('[BSC/PancakeSwap] Handler error:', err?.message);
      }
    });

    // Hook WebSocket close for reconnect
    const ws: any = (wsProvider as any)._websocket ?? (wsProvider as any).websocket;
    if (ws) {
      const onClose = () => {
        console.warn('[BSC/PancakeSwap] WebSocket closed — reconnecting in 5s...');
        factory.removeAllListeners();
        scheduleReconnect();
      };
      if (typeof ws.on === 'function') {
        ws.on('close', onClose);
        ws.on('error', (e: any) => console.error('[BSC/PancakeSwap] WS error:', e?.message));
      } else if (typeof ws.addEventListener === 'function') {
        ws.addEventListener('close', onClose);
      }
    }

    console.log('[BSC/PancakeSwap] Listening for PairCreated events...');
  } catch (err: any) {
    console.error('[BSC/PancakeSwap] Connection failed:', err?.message);
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (reconnecting) return;
  reconnecting = true;
  setTimeout(() => {
    reconnecting = false;
    connect();
  }, 5000);
}

// ── Main detection pipeline ────────────────────────────────────────────────────
async function handlePairCreated(
  token0: string,
  token1: string,
  pair: string,
  txHash: string,
): Promise<void> {
  // Identify which side is the new token
  const isToken0Quote = QUOTE_TOKENS.has(token0.toLowerCase());
  const isToken1Quote = QUOTE_TOKENS.has(token1.toLowerCase());

  // Skip token↔token pairs (both are quote tokens or neither)
  if (isToken0Quote === isToken1Quote) return;

  const tokenAddress = isToken0Quote ? token1 : token0;
  const quoteAddress = isToken0Quote ? token0 : token1;
  const isWbnbPair   = quoteAddress.toLowerCase() === WBNB.toLowerCase();

  console.log(`[BSC/PancakeSwap] 👀 New pair detected: ${tokenAddress} | tx: ${txHash.slice(0, 16)}…`);

  const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, httpProvider);
  const quoteContract = new ethers.Contract(quoteAddress, ERC20_ABI, httpProvider);

  // Batch all RPC calls
  const [totalSupplyRaw, decimalsRaw, name, symbol, lpTokenRaw, quoteInPairRaw] =
    await Promise.all([
      tokenContract.totalSupply(),
      tokenContract.decimals().catch(() => 18n),
      tokenContract.name().catch(() => 'Unknown'),
      tokenContract.symbol().catch(() => 'Unknown'),
      tokenContract.balanceOf(pair),
      quoteContract.balanceOf(pair),
    ]);

  const dec         = Number(decimalsRaw);
  const totalSupply = Number(totalSupplyRaw) / Math.pow(10, dec);
  const lpTokens    = Number(lpTokenRaw)    / Math.pow(10, dec);

  // ── FILTER 1: Supply range ──────────────────────────────────────────────────
  const { bsc } = config;
  if (bsc.supplyMin !== null && totalSupply < bsc.supplyMin) return;
  if (bsc.supplyMax !== null && totalSupply > bsc.supplyMax) return;

  // ── FILTER 2: LP percentage ─────────────────────────────────────────────────
  if (totalSupply === 0) return;
  const lpPct = (lpTokens / totalSupply) * 100;
  if (bsc.lpPctMin !== null && lpPct < bsc.lpPctMin) return;
  if (bsc.lpPctMax !== null && lpPct > bsc.lpPctMax) return;

  // ── FILTER 3: Market cap (USD) ──────────────────────────────────────────────
  const quoteAmount = Number(quoteInPairRaw) / 1e18; // WBNB/BUSD/USDT all 18 dec

  let quoteUsdPrice = 1; // BUSD/USDT are already $1
  if (isWbnbPair) {
    quoteUsdPrice = await getBnbPriceUsd(httpProvider);
  }

  if (lpTokens === 0) return;
  const priceUsd     = (quoteAmount * quoteUsdPrice) / lpTokens;
  const marketCapUsd = priceUsd * totalSupply;

  const lpValueUsd = quoteAmount * quoteUsdPrice;
  if (bsc.lpUsdMin !== null && lpValueUsd < bsc.lpUsdMin) return;
  if (bsc.lpUsdMax !== null && lpValueUsd > bsc.lpUsdMax) return;

  if (bsc.mcapUsdMin !== null && marketCapUsd < bsc.mcapUsdMin) return;
  if (bsc.mcapUsdMax !== null && marketCapUsd > bsc.mcapUsdMax) return;

  // ── Fetch tx for deployer display in alert ────────────────────────────────
  const tx = await httpProvider.getTransaction(txHash);
  if (!tx) return;
  const deployer = tx.from;

  // ── FILTER 4 (optional): Any single wallet holds within % range ────────────
  let topHolderPct: number | null = null;
  if (bsc.holderPctMin !== null || bsc.holderPctMax !== null) {
    const fromBlock = tx.blockNumber ?? 0;
    const transfers = await tokenContract.queryFilter(
      tokenContract.filters.Transfer(), fromBlock, 'latest',
    );

    const EXCLUDED = new Set([pair.toLowerCase(), ethers.ZeroAddress.toLowerCase()]);
    const balances = new Map<string, bigint>();

    for (const ev of transfers) {
      const e    = ev as ethers.EventLog;
      const from = (e.args[0] as string).toLowerCase();
      const to   = (e.args[1] as string).toLowerCase();
      const val  = e.args[2] as bigint;
      if (!EXCLUDED.has(from)) balances.set(from, (balances.get(from) ?? 0n) - val);
      if (!EXCLUDED.has(to))   balances.set(to,   (balances.get(to)   ?? 0n) + val);
    }

    const positiveBalances = [...balances.values()].filter(b => b > 0n);

    const anyInRange = positiveBalances.some(bal => {
      const pct = (Number(bal) / Number(totalSupplyRaw)) * 100;
      if (bsc.holderPctMin !== null && pct < bsc.holderPctMin) return false;
      if (bsc.holderPctMax !== null && pct > bsc.holderPctMax) return false;
      return true;
    });

    if (!anyInRange) return;

    topHolderPct = positiveBalances.length > 0
      ? Math.max(...positiveBalances.map(b => (Number(b) / Number(totalSupplyRaw)) * 100))
      : 0;
  }

  // ── ALL FILTERS PASSED ──────────────────────────────────────────────────────
  console.log(`[BSC/PancakeSwap] MATCH: ${name} (${symbol}) | CA: ${tokenAddress}`);
  console.log(`  Supply: ${formatNum(totalSupply)} | LP: ${lpPct.toFixed(1)}% | MC: $${formatNum(marketCapUsd)}${topHolderPct !== null ? ` | Top holder: ${topHolderPct.toFixed(1)}%` : ''}`);

  const quoteLabel = isWbnbPair ? 'BNB' : (quoteAddress.toLowerCase() === USDT.toLowerCase() ? 'USDT' : 'BUSD');

  const msg = [
    `🟢 *BSC STEALTH LAUNCH — MATCH*`,
    `🥞 *PancakeSwap V2*`,
    ``,
    `🪙 *Name:*   ${esc(name)}`,
    `🔤 *Symbol:* ${esc(symbol)}`,
    `📍 *CA:* \`${tokenAddress}\``,
    `👤 *Deployer:* \`${deployer}\``,
    `📦 *Pair:* \`${pair}\``,
    ``,
    `📊 *Total Supply:* ${formatNum(totalSupply)}`,
    `💧 *LP allocation:* ${lpPct.toFixed(2)}% of supply`,
    `${isWbnbPair ? '🔶' : '💵'} *${quoteLabel} in LP:* ${quoteAmount.toFixed(4)} ${quoteLabel} (~$${formatNum(lpValueUsd)})`,
    `💰 *Launch MC:* $${formatNum(marketCapUsd)}`,
    topHolderPct !== null ? `🏦 *Top holder:* ${topHolderPct.toFixed(2)}% of supply` : '',
    ``,
    `🔗 [BscScan](https://bscscan.com/token/${tokenAddress})  |  [Dexscreener](https://dexscreener.com/bsc/${tokenAddress})  |  [Poocoin](https://poocoin.app/tokens/${tokenAddress})`,
    ``,
    `📋 [${txHash.slice(0, 16)}…](https://bscscan.com/tx/${txHash})`,
    `⏰ ${new Date().toUTCString()}`,
  ].filter(line => line !== '').join('\n');

  await sendStatusMessage(msg);

  watchPairForBuys(pair, tokenAddress, quoteAddress, name, symbol, isWbnbPair, dec);
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function formatNum(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9)  return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6)  return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3)  return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(2);
}

function esc(text: string): string {
  return (text || '').replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}
