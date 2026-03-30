/**
 * Solana Token Finder
 * ───────────────────
 * Monitors Solana for new token deployments across:
 *   • Pump.fun
 *   • Traditional SPL / Token-2022
 *   • Raydium (new liquidity pools)
 *   • Other launchpads (Moonshot, Boop, Meteora, Believe.app, custom)
 *
 * 3-stage Telegram notifications:
 *   Stage 1 → Token detected at creation
 *   Stage 2 → Supply starts distributing across wallets
 *   Stage 3 → Distribution matches your specified pattern
 */

import { Connection } from '@solana/web3.js';
import { config }               from './config';
import { initTelegram, sendStatusMessage } from './notifiers/telegram';
import { startPumpfunMonitor }    from './monitors/pumpfun';
import { startTraditionalMonitor } from './monitors/traditional';
import { startRaydiumMonitor }    from './monitors/raydium';
import { startLaunchpadMonitors } from './monitors/launchpads';
import { startDistributionMonitor } from './watchlist/distributionMonitor';
import { startMetaplexMonitor }     from './monitors/metaplex';
import { startDiscordMonitor }      from './monitors/discord';
import { startVestingMonitor }      from './monitors/vesting';

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Solana Token Finder — Starting');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // ── Telegram ────────────────────────────────────────────────────────────────
  initTelegram();

  // ── Solana connection ───────────────────────────────────────────────────────
  const connection = new Connection(config.rpc.endpoint, {
    wsEndpoint: config.rpc.wsEndpoint,
    commitment: 'confirmed',
  });

  console.log(`[RPC] Connected to ${config.rpc.endpoint}`);

  // ── Active monitors ─────────────────────────────────────────────────────────
  if (config.monitors.pumpfun)     startPumpfunMonitor(connection);
  if (config.monitors.traditional) startTraditionalMonitor(connection);
  if (config.monitors.raydium)     startRaydiumMonitor(connection);
  if (config.monitors.launchpads)  startLaunchpadMonitors(connection);

  // ── Metaplex monitor — catches all tokens with metadata regardless of platform
  startMetaplexMonitor(connection);

  // ── Discord monitor — watches for CA drops in Discord channels
  if (config.monitors.discord) startDiscordMonitor();

  // ── Vesting monitor — fires when team tokens are locked just before launch
  if (config.monitors.vesting) startVestingMonitor(connection);

  // ── Distribution monitor (Stage 2 + 3) ─────────────────────────────────────
  startDistributionMonitor(connection);

  // ── Print active config summary ─────────────────────────────────────────────
  const summary = buildConfigSummary();
  console.log(summary);

  // ── Telegram startup notification ───────────────────────────────────────────
  await sendStatusMessage(
    `✅ *Solana Token Finder — Online*\n\n` + telegramSummary()
  );

  // ── Keep process alive ──────────────────────────────────────────────────────
  process.on('SIGINT',  () => shutdown());
  process.on('SIGTERM', () => shutdown());
}

function buildConfigSummary(): string {
  const { filters, distribution, monitors } = config;

  const lines = [
    '',
    '── Active Monitors ──────────────────────────────',
    `  Pump.fun:     ${monitors.pumpfun     ? '✓' : '✗'}`,
    `  Traditional:  ${monitors.traditional ? '✓' : '✗'}`,
    `  Raydium:      ${monitors.raydium     ? '✓' : '✗'}`,
    `  Launchpads:   ${monitors.launchpads  ? '✓' : '✗'}`,
    `  Discord:      ${monitors.discord     ? '✓' : '✗'}`,
    `  Vesting:      ${monitors.vesting     ? '✓' : '✗'}`,
    '',
    '── Filters ──────────────────────────────────────',
    `  Require socials:  ${filters.requireSocials}`,
    `  Name keywords:    ${filters.nameKeywords.length > 0 ? filters.nameKeywords.join(', ') : '(all tokens)'}`,
    `  Twitter keywords: ${filters.twitterKeywords.join(', ') || '(any)'}`,
    `  Telegram keywords: ${filters.telegramKeywords.join(', ') || '(any)'}`,
    '',
    '── Distribution ─────────────────────────────────',
    `  Stage 2 at:  ${distribution.stage2MinHolders} holders`,
    `  Pattern:     ${distribution.pattern.length > 0 ? `[${distribution.pattern.join(', ')}]% ±${distribution.tolerance}%` : '(not set)'}`,
    `  Poll every:  ${distribution.pollIntervalMs / 1000}s`,
    `  Watch for:   ${distribution.watchDurationMs / 3600000}h`,
    '─────────────────────────────────────────────────',
    '',
  ];

  return lines.join('\n');
}

function telegramSummary(): string {
  const { filters, distribution, monitors } = config;
  const active = [
    monitors.pumpfun     ? 'Pump\\.fun' : '',
    monitors.traditional ? 'SPL Token' : '',
    monitors.raydium     ? 'Raydium'   : '',
    monitors.launchpads  ? 'Other Launchpads' : '',
  ].filter(Boolean).join(', ');

  const nameFilter = filters.nameKeywords.length > 0
    ? filters.nameKeywords.join(', ')
    : '_all tokens_';

  const distPattern = distribution.pattern.length > 0
    ? `\`[${distribution.pattern.join(', ')}]%\` ±${distribution.tolerance}%`
    : '_not set_';

  return [
    `*Monitors:* ${active}`,
    `*Name filter:* ${nameFilter}`,
    `*Socials required:* ${filters.requireSocials ? 'Yes' : 'No'}`,
    `*Distribution pattern:* ${distPattern}`,
    `*Stage 2 threshold:* ${distribution.stage2MinHolders} holders`,
  ].join('\n');
}

async function shutdown() {
  console.log('\n[Shutdown] Stopping...');
  await sendStatusMessage('⛔ *Solana Token Finder — Offline*').catch(() => {});
  process.exit(0);
}

main().catch(err => {
  console.error('[Fatal]', err);
  process.exit(1);
});
