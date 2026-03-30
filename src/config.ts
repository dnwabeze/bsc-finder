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
  telegram: {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    chatId:   required('TELEGRAM_CHAT_ID'),
  },
  monitors: {
    pumpfun:     bool('MONITOR_PUMPFUN',     true),
    traditional: bool('MONITOR_TRADITIONAL', true),
    raydium:     bool('MONITOR_RAYDIUM',     true),
    launchpads:  bool('MONITOR_LAUNCHPADS',  true),
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
