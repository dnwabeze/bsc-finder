import { ethers } from 'ethers';
import { config } from '../../config';
import { sendStatusMessage } from '../../notifiers/telegram';
import { getBnbPriceUsd } from './bnbPrice';

const PAIR_ABI = [
  'event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)',
];

interface WatchedPair {
  pairContract: ethers.Contract;
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  isWbnbPair: boolean;
  quoteIsToken0: boolean;
  tokenDecimals: number;
  timer: ReturnType<typeof setTimeout>;
}

const watched = new Map<string, WatchedPair>();
let wsProvider: ethers.WebSocketProvider | null = null;
let httpProvider: ethers.JsonRpcProvider;

export function initBuyWatcher(): void {
  httpProvider = new ethers.JsonRpcProvider(config.bsc.rpcEndpoint);
}

function getWsProvider(): ethers.WebSocketProvider {
  if (!wsProvider) {
    wsProvider = new ethers.WebSocketProvider(config.bsc.wsEndpoint);
    const ws: any = (wsProvider as any)._websocket ?? (wsProvider as any).websocket;
    if (ws) {
      const onClose = () => {
        console.warn('[BSC/BuyWatcher] WebSocket closed — reconnecting in 5s...');
        wsProvider = null;
        setTimeout(() => resubscribeAll(), 5000);
      };
      if (typeof ws.on === 'function') {
        ws.on('close', onClose);
        ws.on('error', (e: any) => console.error('[BSC/BuyWatcher] WS error:', e?.message));
      } else if (typeof ws.addEventListener === 'function') {
        ws.addEventListener('close', onClose);
      }
    }
  }
  return wsProvider;
}

function resubscribeAll(): void {
  for (const [pairAddress, info] of watched) {
    const contract = new ethers.Contract(pairAddress, PAIR_ABI, getWsProvider());
    info.pairContract = contract;
    attachSwapListener(pairAddress, contract, info);
  }
}

export function watchPairForBuys(
  pairAddress: string,
  tokenAddress: string,
  quoteAddress: string,
  tokenName: string,
  tokenSymbol: string,
  isWbnbPair: boolean,
  tokenDecimals: number,
): void {
  if (watched.has(pairAddress)) return;

  // PancakeSwap V2 sorts token0 < token1 by address
  const quoteIsToken0 = quoteAddress.toLowerCase() < tokenAddress.toLowerCase();

  const contract = new ethers.Contract(pairAddress, PAIR_ABI, getWsProvider());

  const timer = setTimeout(() => stopWatching(pairAddress), config.bsc.buyWatchDurationMs);

  const info: WatchedPair = {
    pairContract: contract,
    tokenAddress,
    tokenName,
    tokenSymbol,
    isWbnbPair,
    quoteIsToken0,
    tokenDecimals,
    timer,
  };

  watched.set(pairAddress, info);
  attachSwapListener(pairAddress, contract, info);

  console.log(`[BSC/BuyWatcher] Watching buys on ${tokenName} (${tokenSymbol}) — pair ${pairAddress}`);
}

function attachSwapListener(
  pairAddress: string,
  contract: ethers.Contract,
  info: WatchedPair,
): void {
  contract.on('Swap', async (
    _sender: string,
    amount0In: bigint,
    amount1In: bigint,
    amount0Out: bigint,
    amount1Out: bigint,
    to: string,
    event: ethers.ContractEventPayload,
  ) => {
    if (!watched.has(pairAddress)) return;

    // Buy = quote token going in, new token coming out
    const isBuy = info.quoteIsToken0
      ? (amount0In > 0n && amount1Out > 0n)
      : (amount1In > 0n && amount0Out > 0n);

    if (!isBuy) return;

    const quoteRaw  = info.quoteIsToken0 ? amount0In  : amount1In;
    const tokenRaw  = info.quoteIsToken0 ? amount1Out : amount0Out;

    const quoteAmount  = Number(quoteRaw) / 1e18;
    const tokenAmount  = Number(tokenRaw) / Math.pow(10, info.tokenDecimals);

    let quoteUsdPrice = 1;
    if (info.isWbnbPair) {
      quoteUsdPrice = await getBnbPriceUsd(httpProvider);
    }

    const spentUsd = quoteAmount * quoteUsdPrice;

    if (config.bsc.buyAlertMinUsd !== null && spentUsd < config.bsc.buyAlertMinUsd) return;

    const priceUsd   = tokenAmount > 0 ? spentUsd / tokenAmount : 0;
    const quoteLabel = info.isWbnbPair ? 'BNB' : 'BUSD/USDT';
    const txHash     = event?.log?.transactionHash ?? 'unknown';

    const msg = [
      `🟡 *BSC BUY DETECTED*`,
      `🥞 *PancakeSwap V2*`,
      ``,
      `🪙 *${esc(info.tokenName)}* \\(${esc(info.tokenSymbol)}\\)`,
      `📍 *CA:* \`${info.tokenAddress}\``,
      ``,
      `👤 *Buyer:* \`${to}\``,
      `💸 *Spent:* ${quoteAmount.toFixed(4)} ${quoteLabel} \\(~$${formatNum(spentUsd)}\\)`,
      `🛒 *Received:* ${formatNum(tokenAmount)} ${esc(info.tokenSymbol)}`,
      `💰 *Price:* $${priceUsd.toFixed(8)} per token`,
      ``,
      `🔗 [BscScan Tx](https://bscscan.com/tx/${txHash})  |  [Chart](https://dexscreener.com/bsc/${info.tokenAddress})`,
      `⏰ ${new Date().toUTCString()}`,
    ].join('\n');

    await sendStatusMessage(msg).catch((err: any) =>
      console.error('[BSC/BuyWatcher] Telegram error:', err?.message),
    );
  });
}

function stopWatching(pairAddress: string): void {
  const info = watched.get(pairAddress);
  if (!info) return;
  clearTimeout(info.timer);
  info.pairContract.removeAllListeners();
  watched.delete(pairAddress);
  console.log(`[BSC/BuyWatcher] Stopped watching ${info.tokenName} (${info.tokenSymbol})`);
}

function formatNum(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9)  return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6)  return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3)  return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(4);
}

function esc(text: string): string {
  return (text || '').replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}
