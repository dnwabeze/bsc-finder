import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string = ''): string {
  return process.env[key] || fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const val = process.env[key];
  if (val === undefined) return fallback;
  return val.toLowerCase() === 'true';
}

function keywords(key: string): string[] {
  const val = optional(key);
  if (!val.trim()) return [];
  return val.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
}

function optionalNumber(key: string): number | null {
  const val = process.env[key];
  if (!val || val.trim() === '') return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

/**
 * Parse distribution pattern from env.
 * DISTRIBUTION_PATTERN=20,12,10,8,5,5,3,3,2,1
 * Returns sorted descending array of percentages.
 */
function distributionPattern(): number[] {
  const val = optional('DISTRIBUTION_PATTERN');
  if (!val.trim()) return [];
  return val
    .split(',')
    .map(s => parseFloat(s.trim()))
    .filter(n => !isNaN(n) && n > 0)
    .sort((a, b) => b - a); // ensure descending
}

export const config = {
  rpc: {
    endpoint:   optional('RPC_ENDPOINT',    'https://api.mainnet-beta.solana.com'),
    wsEndpoint: optional('RPC_WS_ENDPOINT', 'wss://api.mainnet-beta.solana.com'),
  },
  // ── BSC / BNB Chain ──────────────────────────────────────────────────────────
  bsc: {
    rpcEndpoint: optional('BSC_RPC_ENDPOINT', 'https://bsc-dataseed1.binance.org'),
    wsEndpoint:  optional('BSC_WS_ENDPOINT',  'wss://bsc-ws-node.nariox.org'),
    pancakeswap: bool('MONITOR_BSC_PANCAKESWAP', false),
    // Filters (null = disabled)
    supplyMin:    optionalNumber('FILTER_BSC_SUPPLY_MIN'),
    supplyMax:    optionalNumber('FILTER_BSC_SUPPLY_MAX'),
    lpPctMin:     optionalNumber('FILTER_BSC_LP_PCT_MIN'),
    lpPctMax:     optionalNumber('FILTER_BSC_LP_PCT_MAX'),
    lpUsdMin:     optionalNumber('FILTER_BSC_LP_USD_MIN'),
    lpUsdMax:     optionalNumber('FILTER_BSC_LP_USD_MAX'),
    mcapUsdMin:   optionalNumber('FILTER_BSC_MCAP_USD_MIN'),
    mcapUsdMax:   optionalNumber('FILTER_BSC_MCAP_USD_MAX'),
    holderPctMin: optionalNumber('FILTER_BSC_HOLDER_PCT_MIN'),
    holderPctMax: optionalNumber('FILTER_BSC_HOLDER_PCT_MAX'),
    // Buy watcher
    buyWatchDurationMs: parseInt(optional('BSC_BUY_WATCH_DURATION_MS', String(60 * 60 * 1000))),
    buyAlertMinUsd: optionalNumber('BSC_BUY_ALERT_MIN_USD'),
    // ── Stealth pre-distribution detector ──────────────────────────────────────
    stealthDeployer:     bool('MONITOR_BSC_STEALTH', false),
    // Minimum number of unique wallets funded before alert fires (default: 3)
    stealthMinWallets:   parseInt(optional('BSC_STEALTH_MIN_WALLETS', '3')),
    // How many hours back to scan on startup (default: 24)
    stealthLookbackHours: parseFloat(optional('BSC_STEALTH_LOOKBACK_HOURS', '24')),
    // Optional supply filter for stealth detector (null = any supply)
    stealthMinSupply:    optionalNumber('BSC_STEALTH_MIN_SUPPLY'),
    stealthMaxSupply:    optionalNumber('BSC_STEALTH_MAX_SUPPLY'),
    // How many hours to keep watching a token that still has no LP (default: 48)
    stealthWatchHours:   parseFloat(optional('BSC_STEALTH_WATCH_HOURS', '48')),
  },
  telegram: {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    chatId:   required('TELEGRAM_CHAT_ID'),
  },
  monitors: {
    pumpfun:     bool('MONITOR_PUMPFUN',     true),
    traditional: bool('MONITOR_TRADITIONAL', true),
    raydium:     bool('MONITOR_RAYDIUM',     true),
    launchpads:  bool('MONITOR_LAUNCHPADS',  true),
    metaplex:    bool('MONITOR_METAPLEX',    true),
    discord:     bool('MONITOR_DISCORD',     false),
    vesting:     bool('MONITOR_VESTING',     false),
  },
  filters: {
    requireSocials:   bool('REQUIRE_SOCIALS', false),
    twitterKeywords:  keywords('FILTER_TWITTER_KEYWORDS'),
    telegramKeywords: keywords('FILTER_TELEGRAM_KEYWORDS'),
    websiteKeywords:  keywords('FILTER_WEBSITE_KEYWORDS'),
    nameKeywords:     keywords('FILTER_NAME_KEYWORDS'),
    // Supply in human units (e.g. 1000000000 = 1B). Leave null to disable.
    minSupply:        optionalNumber('FILTER_MIN_SUPPLY'),
    maxSupply:        optionalNumber('FILTER_MAX_SUPPLY'),
  },
  // ── Discord Monitor ──────────────────────────────────────────────────────────
  discord: {
    botToken:   optional('DISCORD_BOT_TOKEN'),
    // Comma-separated Discord channel IDs to watch for CA drops
    channelIds: optional('DISCORD_CHANNEL_IDS')
      .split(',').map(s => s.trim()).filter(Boolean),
  },
  // ── Vesting Monitor ──────────────────────────────────────────────────────────
  vesting: {
    // Exact total supply to match (human units, e.g. 730000000 = 730M). ±1% tolerance.
    // Leave empty to fall back to FILTER_MIN/MAX_SUPPLY.
    exactSupply:   optionalNumber('FILTER_EXACT_SUPPLY'),
    // Extra vesting program IDs beyond built-in Streamflow
    extraPrograms: optional('VESTING_PROGRAMS')
      .split(',').map(s => s.trim()).filter(Boolean),
  },
  distribution: {
    // Pattern: sorted-descending list of target wallet percentages
    // e.g. [20, 12, 10, 8, 5] means:
    //   top holder   ≈ 20%
    //   2nd holder   ≈ 12%
    //   3rd holder   ≈ 10%  ... etc
    pattern:   distributionPattern(),

    // How many % points each slot is allowed to deviate from the target
    // e.g. tolerance=5 means target 20% accepts 15%–25%
    tolerance: parseFloat(optional('DISTRIBUTION_TOLERANCE', '5')),

    // How many wallets must hold tokens before Stage 2 fires
    stage2MinHolders: parseInt(optional('DISTRIBUTION_STAGE2_MIN_HOLDERS', '3')),

    // How often to poll watched tokens (ms)
    pollIntervalMs: parseInt(optional('DISTRIBUTION_POLL_INTERVAL_MS', '15000')),

    // How long to keep watching a token after detection (ms), default 6 hours
    watchDurationMs: parseInt(optional('DISTRIBUTION_WATCH_DURATION_MS', String(6 * 60 * 60 * 1000))),
  },
  metadataFetchTimeout: parseInt(optional('METADATA_FETCH_TIMEOUT', '3000')),
};

// ─── Well-known Program IDs ────────────────────────────────────────────────
export const PROGRAMS = {
  TOKEN_PROGRAM:      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  TOKEN_2022_PROGRAM: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  PUMPFUN_PROGRAM:    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  METAPLEX_PROGRAM:   'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  RAYDIUM_AMM:        '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  RAYDIUM_CLMM:       'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
};
