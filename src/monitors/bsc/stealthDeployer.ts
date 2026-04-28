import { ethers } from 'ethers';
import { config } from '../../config';
import { sendStatusMessage } from '../../notifiers/telegram';

// ── Addresses ──────────────────────────────────────────────────────────────────
const PANCAKESWAP_V2_FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const BUSD = '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56';
const USDT = '0x55d398326f99059fF775485246999027B3197955';

// Transfer(address indexed from, address indexed to, uint256 value)
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
// topic[1] = from address padded to 32 bytes — we want from = address(0)
const ZERO_TOPIC = '0x' + '00'.repeat(32);

// ── ABIs ───────────────────────────────────────────────────────────────────────
const ERC20_ABI = [
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

const FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) view returns (address pair)',
];

// Used to detect LP pair tokens — they implement token0(), regular ERC20s don't
const PAIR_ABI = ['function token0() view returns (address)'];

// ── State ──────────────────────────────────────────────────────────────────────
interface TrackedToken {
  address: string;
  deployer: string;
  name: string;
  symbol: string;
  totalSupplyRaw: bigint;
  decimals: number;
  mintTxHash: string;
  mintBlock: number;
  recipients: Map<string, bigint>; // wallet → total received from deployer
  lastAlertedCount: number; // wallet count at time of last alert (0 = never alerted)
  cancelled: boolean;
  expiresAt: number; // ms timestamp
}

const tracked = new Map<string, TrackedToken>(); // lowercase tokenAddress → state

let httpProvider: ethers.JsonRpcProvider;
let wsProvider: ethers.WebSocketProvider;
let factory: ethers.Contract;
let reconnecting = false;
let reconnectDelay = 5_000;
const MAX_RECONNECT_DELAY = 120_000;

// ── Entry point ────────────────────────────────────────────────────────────────
export function startBscStealthDeployerMonitor(): void {
  console.log('[BSC/StealthDeployer] Starting monitor...');
  httpProvider = new ethers.JsonRpcProvider(config.bsc.rpcEndpoint);
  factory = new ethers.Contract(PANCAKESWAP_V2_FACTORY, FACTORY_ABI, httpProvider);

  // Connect immediately so real-time watching starts right away,
  // then run the lookback in the background without blocking startup.
  connect();
  runLookback().catch(err =>
    console.error('[BSC/StealthDeployer] Lookback error:', err?.message),
  );
}

// ── Lookback: scan last N hours of blocks for mint events ──────────────────────
async function runLookback(): Promise<void> {
  const hours = config.bsc.stealthLookbackHours;
  // BSC produces ~1 block every 3 seconds → 1200 blocks/hour
  const lookbackBlocks = Math.round(hours * 1200);
  const latestBlock = await httpProvider.getBlockNumber();
  const fromBlock = Math.max(0, latestBlock - lookbackBlocks);

  console.log(`[BSC/StealthDeployer] Lookback: last ${hours}h (~${lookbackBlocks} blocks, from ${fromBlock} to ${latestBlock})...`);

  const CHUNK = 500;
  for (let start = fromBlock; start <= latestBlock; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, latestBlock);
    try {
      const logs = await httpProvider.getLogs({
        fromBlock: start,
        toBlock: end,
        topics: [TRANSFER_TOPIC, ZERO_TOPIC],
      });
      for (const log of logs) {
        await handleMintLog(log, true);
      }
    } catch (err: any) {
      console.error(`[BSC/StealthDeployer] Lookback chunk ${start}-${end} failed:`, err?.message);
    }
  }

  const activeCount = [...tracked.values()].filter(t => !t.cancelled).length;
  console.log(`[BSC/StealthDeployer] Lookback complete — tracking ${activeCount} token(s) without LP.`);
}

// ── WebSocket connection with auto-reconnect ───────────────────────────────────
function connect(): void {
  try {
    wsProvider = new ethers.WebSocketProvider(config.bsc.wsEndpoint);

    // Subscribe to ALL Transfer(address(0), ...) logs across all BSC contracts
    wsProvider.on(
      { topics: [TRANSFER_TOPIC, ZERO_TOPIC] },
      async (log: ethers.Log) => {
        try {
          await handleMintLog(log, false);
        } catch (err: any) {
          console.error('[BSC/StealthDeployer] Mint handler error:', err?.message);
        }
      },
    );

    const ws: any = (wsProvider as any)._websocket ?? (wsProvider as any).websocket;
    if (ws) {
      const onClose = () => scheduleReconnect();
      if (typeof ws.on === 'function') {
        ws.on('close', onClose);
        ws.on('error', (e: any) => {
          const msg = e?.message ?? String(e);
          console.error('[BSC/StealthDeployer] WS error:', msg);
          if (msg.includes('429')) scheduleReconnect(true);
        });
      } else if (typeof ws.addEventListener === 'function') {
        ws.addEventListener('close', onClose);
      }
    }

    reconnectDelay = 5_000; // reset backoff on successful connect
    console.log('[BSC/StealthDeployer] Listening for new mints...');
  } catch (err: any) {
    console.error('[BSC/StealthDeployer] Connection failed:', err?.message);
    scheduleReconnect();
  }
}

function scheduleReconnect(rateLimited = false): void {
  if (reconnecting) return;
  reconnecting = true;
  const delay = rateLimited ? Math.max(reconnectDelay, 30_000) : reconnectDelay;
  reconnectDelay = Math.min(delay * 2, MAX_RECONNECT_DELAY);
  console.warn(`[BSC/StealthDeployer] WebSocket closed — reconnecting in ${delay / 1000}s...`);
  setTimeout(() => { reconnecting = false; connect(); }, delay);
}

// ── Handle a Transfer(0x0 → deployer) mint log ────────────────────────────────
async function handleMintLog(log: ethers.Log, isLookback: boolean): Promise<void> {
  // Needs at least 3 topics: Transfer sig, from, to
  if (log.topics.length < 3) return;

  const tokenAddress = log.address.toLowerCase();
  if (tracked.has(tokenAddress)) return;

  // Decode deployer (topic[2] = to address, padded to 32 bytes)
  let deployer: string;
  let mintedAmount: bigint;
  try {
    deployer     = ethers.getAddress('0x' + log.topics[2].slice(-40));
    mintedAmount = BigInt(log.data === '0x' ? '0' : log.data);
  } catch {
    return;
  }

  if (deployer.toLowerCase() === ethers.ZeroAddress.toLowerCase()) return;
  if (mintedAmount === 0n) return;

  // Skip LP pair tokens — they emit Transfer(0x0, ...) on every liquidity add.
  // Pair contracts implement token0(); regular ERC20s do not.
  try {
    const pairCheck = new ethers.Contract(tokenAddress, PAIR_ABI, httpProvider);
    await pairCheck.token0();
    return; // it's a Cake-LP or any Uniswap-style pair token — skip
  } catch { /* not a pair contract — proceed */ }

  // Skip if the mint recipient is a contract (e.g. dividend trackers, wrapped tokens,
  // protocol vaults). Real stealth launches mint the full supply to a human wallet (EOA).
  const deployerCode = await httpProvider.getCode(deployer);
  if (deployerCode !== '0x') return;

  // Fetch ERC20 metadata
  const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, httpProvider);
  let name = 'Unknown', symbol = 'Unknown', decimals = 18, totalSupplyOnChain = 0n;
  try {
    const [n, s, d, ts] = await Promise.all([
      tokenContract.name().catch(() => 'Unknown'),
      tokenContract.symbol().catch(() => 'Unknown'),
      tokenContract.decimals().catch(() => 18n),
      tokenContract.totalSupply().catch(() => 0n),
    ]);
    name               = n as string;
    symbol             = s as string;
    decimals           = Number(d);
    totalSupplyOnChain = ts as bigint;
  } catch { /* ignore — token might not be ERC20 */ }

  // Skip if this mint only covers a fraction of the total supply.
  // A real stealth ERC20 mints 100% to the deployer in one shot.
  // Stablecoins and DeFi vaults mint in batches so mintedAmount << totalSupply.
  if (totalSupplyOnChain > 0n) {
    const mintPct = Number(mintedAmount) / Number(totalSupplyOnChain);
    if (mintPct < 0.95) return;
  }

  const supplyHuman = Number(mintedAmount) / Math.pow(10, decimals);

  // Apply optional supply filter
  if (config.bsc.stealthMinSupply !== null && supplyHuman < config.bsc.stealthMinSupply) return;
  if (config.bsc.stealthMaxSupply !== null && supplyHuman > config.bsc.stealthMaxSupply) return;

  // Skip if LP already exists
  const hasLp = await checkLpExists(tokenAddress);
  if (hasLp) return;

  // Only track if deployer STILL holds 100% of supply right now (pristine — no distribution yet).
  // This filters out any token from lookback that has already started distributing.
  const deployerBalNow = await tokenContract.balanceOf(deployer).catch(() => 0n) as bigint;
  if (totalSupplyOnChain > 0n) {
    const deployerHoldsPct = Number(deployerBalNow) / Number(totalSupplyOnChain);
    if (deployerHoldsPct < 0.99) return; // already moved tokens — skip
  }

  const mintBlock  = typeof log.blockNumber === 'number' ? log.blockNumber : Number(log.blockNumber);
  const expiresAt  = Date.now() + config.bsc.stealthWatchHours * 60 * 60 * 1000;

  tracked.set(tokenAddress, {
    address:          tokenAddress,
    deployer:         deployer.toLowerCase(),
    name,
    symbol,
    totalSupplyRaw:   totalSupplyOnChain > 0n ? totalSupplyOnChain : mintedAmount,
    decimals,
    mintTxHash:       log.transactionHash,
    mintBlock,
    recipients:       new Map(),
    lastAlertedCount: 0,
    cancelled:        false,
    expiresAt,
  });

  console.log(`[BSC/StealthDeployer] ${isLookback ? '[LOOKBACK]' : '[LIVE]'} Tracking: ${name} (${symbol}) CA: ${tokenAddress} — deployer holds 100%`);

  // Deployer holds full supply — start polling for when they begin distributing
  startPolling(tokenAddress);
}

// ── Poll for new deployer→wallet transfers every 15s ─────────────────────────
function startPolling(tokenAddress: string): void {
  const state = tracked.get(tokenAddress);
  if (!state) return;

  let lastCheckedBlock = state.mintBlock;

  const poll = async () => {
    const st = tracked.get(tokenAddress);
    if (!st || st.cancelled) return;

    if (Date.now() > st.expiresAt) {
      tracked.delete(tokenAddress);
      console.log(`[BSC/StealthDeployer] Watch expired: ${st.name} (${tokenAddress})`);
      return;
    }

    try {
      const latestBlock = await httpProvider.getBlockNumber();
      if (latestBlock > lastCheckedBlock) {
        // Check LP before doing transfer scan
        const hasLp = await checkLpExists(tokenAddress);
        if (hasLp) {
          tracked.delete(tokenAddress);
          console.log(`[BSC/StealthDeployer] LP added — stopping watch: ${st.name} (${tokenAddress})`);
          return;
        }

        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, httpProvider);
        const transfers = await tokenContract.queryFilter(
          tokenContract.filters.Transfer(st.deployer, null),
          lastCheckedBlock + 1,
          latestBlock,
        );

        lastCheckedBlock = latestBlock;

        for (const ev of transfers) {
          const e   = ev as ethers.EventLog;
          const to  = (e.args[1] as string).toLowerCase();
          const val = e.args[2] as bigint;
          recordTransfer(tokenAddress, to, val);
        }

        await maybeAlert(tokenAddress);
      }
    } catch (err: any) {
      console.error(`[BSC/StealthDeployer] Poll error for ${tokenAddress}:`, err?.message);
    }

    setTimeout(poll, 15_000);
  };

  setTimeout(poll, 15_000);
}

// ── Record a transfer from deployer to a recipient wallet ─────────────────────
function recordTransfer(tokenAddress: string, to: string, amount: bigint): void {
  const state = tracked.get(tokenAddress);
  if (!state || state.cancelled) return;

  // Ignore burns and self-transfers
  if (to === ethers.ZeroAddress.toLowerCase()) return;
  if (to === state.deployer) return;

  state.recipients.set(to, (state.recipients.get(to) ?? 0n) + amount);
}

// ── Check threshold and fire alert (or update) ────────────────────────────────
async function maybeAlert(tokenAddress: string): Promise<void> {
  const state = tracked.get(tokenAddress);
  if (!state || state.cancelled) return;

  const count      = state.recipients.size;
  const minWallets = config.bsc.stealthMinWallets;

  // Wait until minimum wallets (default: 3) are funded before first alert
  if (count < minWallets) return;

  // Only fire when the wallet count has increased since last alert
  if (count <= state.lastAlertedCount) return;

  // Verify LP still doesn't exist before alerting
  const hasLp = await checkLpExists(tokenAddress);
  if (hasLp) {
    state.cancelled = true;
    tracked.delete(tokenAddress);
    return;
  }

  // Fire alert — initial or update
  state.lastAlertedCount = count;
  await sendStealthAlert(state);
}

// ── Check if any PancakeSwap V2 LP pair exists for this token ─────────────────
async function checkLpExists(tokenAddress: string): Promise<boolean> {
  try {
    const [pairWbnb, pairBusd, pairUsdt] = await Promise.all([
      factory.getPair(tokenAddress, WBNB),
      factory.getPair(tokenAddress, BUSD),
      factory.getPair(tokenAddress, USDT),
    ]);
    return (
      pairWbnb !== ethers.ZeroAddress ||
      pairBusd !== ethers.ZeroAddress ||
      pairUsdt !== ethers.ZeroAddress
    );
  } catch {
    return false;
  }
}

// ── Build and send Telegram alert (initial or update) ────────────────────────
async function sendStealthAlert(state: TrackedToken): Promise<void> {
  const supplyHuman = Number(state.totalSupplyRaw) / Math.pow(10, state.decimals);
  const isUpdate    = state.lastAlertedCount > config.bsc.stealthMinWallets;
  const headerEmoji = isUpdate ? '🔄' : '🚨';
  const headerLabel = isUpdate ? 'UPDATE — NEW WALLETS FUNDED' : 'PRE-DISTRIBUTION DETECTED';
  const walletNote  = state.recipients.size > 5 ? `\n⚡ _Multisender detected — ${state.recipients.size} wallets funded so far_` : '';

  // Fetch CURRENT balances for every recipient wallet — historical transfer amounts
  // can be stale (wallets may have already moved or sold tokens since distribution).
  const tokenContract = new ethers.Contract(state.address, ERC20_ABI, httpProvider);
  const walletAddrs   = [...state.recipients.keys()];
  const liveBalances  = await Promise.all(
    walletAddrs.map(addr => tokenContract.balanceOf(addr).catch(() => 0n)),
  );

  const walletLines = walletAddrs.map((addr, i) => {
    const bal      = liveBalances[i] as bigint;
    const humanBal = Number(bal) / Math.pow(10, state.decimals);
    const pct      = supplyHuman > 0 ? (humanBal / supplyHuman) * 100 : 0;
    const status   = humanBal === 0 ? ' ⚠️ _sold/moved_' : '';
    return `  ${i + 1}. \`${addr}\` → ${formatNum(humanBal)} (${pct.toFixed(2)}%)${status}`;
  }).join('\n');

  // Deployer's remaining balance
  const deployerBalRaw  = await tokenContract.balanceOf(state.deployer).catch(() => 0n) as bigint;
  const deployerBal     = Number(deployerBalRaw) / Math.pow(10, state.decimals);
  const deployerPct     = supplyHuman > 0 ? (deployerBal / supplyHuman) * 100 : 0;

  const ca = state.address;

  const msg = [
    `${headerEmoji} *BSC STEALTH — ${headerLabel}*`,
    `⚠️ *NO LP YET* — Insider wallets are being seeded`,
    ``,
    `🪙 *Name:*   ${esc(state.name)}`,
    `🔤 *Symbol:* ${esc(state.symbol)}`,
    `📍 *CA:* \`${ca}\``,
    `👤 *Deployer:* \`${state.deployer}\` holds ${formatNum(deployerBal)} (${deployerPct.toFixed(2)}%)`,
    ``,
    `📊 *Total Supply:* ${formatNum(supplyHuman)}`,
    ``,
    `📤 *Funded Wallets (${state.recipients.size}) — live balances:*`,
    walletLines,
    walletNote,
    ``,
    `🔗 [BscScan](https://bscscan.com/token/${ca})  |  [Dexscreener](https://dexscreener.com/bsc/${ca})`,
    ``,
    `📋 [Deploy Tx: ${state.mintTxHash.slice(0, 16)}…](https://bscscan.com/tx/${state.mintTxHash})`,
    `⏰ ${new Date().toUTCString()}`,
  ].filter(l => l !== '').join('\n');

  await sendStatusMessage(msg);

  console.log(`[BSC/StealthDeployer] ${isUpdate ? 'UPDATE' : 'ALERT'}: ${state.name} (${state.symbol}) | CA: ${ca} | Wallets: ${state.recipients.size}`);
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
