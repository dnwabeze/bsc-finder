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
import { startPancakeswapMonitor }      from './monitors/bsc/pancakeswap';
import { startBscStealthDeployerMonitor } from './monitors/bsc/stealthDeployer';

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
  if (config.monitors.metaplex) startMetaplexMonitor(connection);

  // ── Discord monitor — watches for CA drops in Discord channels
  if (config.monitors.discord) startDiscordMonitor();

  // ── Vesting monitor — fires when team tokens are locked just before launch
  if (config.monitors.vesting) startVestingMonitor(connection);

  // ── BSC/PancakeSwap monitor ─────────────────────────────────────────────────
  if (config.bsc.pancakeswap) startPancakeswapMonitor();

  // ── BSC Stealth pre-distribution detector ───────────────────────────────────
  if (config.bsc.stealthDeployer) await startBscStealthDeployerMonitor();

  // ── Distribution monitor (Stage 2 + 3) — only needed when Solana monitors are active
  const anySolanaActive = config.monitors.pumpfun || config.monitors.traditional ||
    config.monitors.raydium || config.monitors.launchpads ||
    config.monitors.metaplex || config.monitors.discord || config.monitors.vesting;
  if (anySolanaActive) startDistributionMonitor(connection);

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
  const { monitors, bsc } = config;

  const lines = [
    '',
    '── Active Monitors ──────────────────────────────',
    `  Pump.fun:        ${monitors.pumpfun     ? '✓' : '✗'}`,
    `  Traditional:     ${monitors.traditional ? '✓' : '✗'}`,
    `  Raydium:         ${monitors.raydium     ? '✓' : '✗'}`,
    `  Launchpads:      ${monitors.launchpads  ? '✓' : '✗'}`,
    `  Metaplex:        ${monitors.metaplex    ? '✓' : '✗'}`,
    `  Discord:         ${monitors.discord     ? '✓' : '✗'}`,
    `  Vesting:         ${monitors.vesting     ? '✓' : '✗'}`,
    `  BSC/PancakeSwap: ${bsc.pancakeswap      ? '✓' : '✗'}`,
    `  BSC/Stealth:     ${bsc.stealthDeployer  ? '✓' : '✗'}`,
  ];

  if (bsc.stealthDeployer) {
    lines.push(
      '',
      '── BSC Stealth Deployer ─────────────────────────',
      `  Alert at:    ${bsc.stealthMinWallets} wallets funded`,
      `  Lookback:    ${bsc.stealthLookbackHours}h`,
      `  Watch for:   ${bsc.stealthWatchHours}h per token`,
      `  Supply:      ${bsc.stealthMinSupply !== null ? `${(bsc.stealthMinSupply / 1e6).toFixed(0)}M` : '—'} – ${bsc.stealthMaxSupply !== null ? `${(bsc.stealthMaxSupply / 1e9).toFixed(2)}B` : '—'}`,
    );
  }

  if (bsc.pancakeswap) {
    lines.push(
      '',
      '── BSC Filters ──────────────────────────────────',
      `  Supply:      ${bsc.supplyMin !== null ? `${(bsc.supplyMin / 1e6).toFixed(0)}M` : '—'} – ${bsc.supplyMax !== null ? `${(bsc.supplyMax / 1e9).toFixed(0)}B` : '—'} tokens`,
      `  LP %:        ${bsc.lpPctMin ?? '—'}% – ${bsc.lpPctMax ?? '—'}%`,
      `  LP USD:      $${bsc.lpUsdMin ?? '—'} – $${bsc.lpUsdMax ?? '—'}`,
      `  Market cap:  $${bsc.mcapUsdMin ?? '—'} – $${bsc.mcapUsdMax ?? '—'}`,
      `  Holder %:    ${bsc.holderPctMin !== null || bsc.holderPctMax !== null ? `${bsc.holderPctMin ?? '—'}% – ${bsc.holderPctMax ?? '—'}%` : 'off'}`,
      '',
      '── BSC Buy Watcher ──────────────────────────────',
      `  Watch duration: ${bsc.buyWatchDurationMs / 60000} min per token`,
      `  Min buy size:   ${bsc.buyAlertMinUsd !== null ? `$${bsc.buyAlertMinUsd}` : 'all buys'}`,
    );
  }

  const anySolana = monitors.pumpfun || monitors.traditional || monitors.raydium ||
    monitors.launchpads || monitors.metaplex || monitors.discord || monitors.vesting;

  if (anySolana) {
    const { filters, distribution } = config;
    lines.push(
      '',
      '── Solana Filters ───────────────────────────────',
      `  Require socials:  ${filters.requireSocials}`,
      `  Name keywords:    ${filters.nameKeywords.length > 0 ? filters.nameKeywords.join(', ') : '(all tokens)'}`,
      `  Twitter keywords: ${filters.twitterKeywords.join(', ') || '(any)'}`,
      '',
      '── Distribution ─────────────────────────────────',
      `  Stage 2 at:  ${distribution.stage2MinHolders} holders`,
      `  Pattern:     ${distribution.pattern.length > 0 ? `[${distribution.pattern.join(', ')}]% ±${distribution.tolerance}%` : '(not set)'}`,
      `  Poll every:  ${distribution.pollIntervalMs / 1000}s`,
      `  Watch for:   ${distribution.watchDurationMs / 3600000}h`,
    );
  }

  lines.push('─────────────────────────────────────────────────', '');
  return lines.join('\n');
}

function telegramSummary(): string {
  const { monitors, bsc } = config;

  const solanaActive = [
    monitors.pumpfun     ? 'Pump\\.fun'       : '',
    monitors.traditional ? 'Traditional SPL'  : '',
    monitors.raydium     ? 'Raydium'          : '',
    monitors.launchpads  ? 'Launchpads'       : '',
    monitors.metaplex    ? 'Metaplex'         : '',
    monitors.discord     ? 'Discord'          : '',
    monitors.vesting     ? 'Vesting'          : '',
  ].filter(Boolean);

  const lines: string[] = [];

  if (bsc.stealthDeployer) {
    lines.push(`🔍 *BSC Stealth Deployer* — Active`);
    lines.push(`  Alert at: ${bsc.stealthMinWallets} wallets funded \\(no LP yet\\)`);
    lines.push(`  Lookback: last ${bsc.stealthLookbackHours}h`);
  }

  if (bsc.pancakeswap) {
    lines.push(`🟡 *BSC/PancakeSwap* — Active`);
    lines.push(`  Supply: ${bsc.supplyMin !== null ? `${(bsc.supplyMin / 1e6).toFixed(0)}M` : '—'} – ${bsc.supplyMax !== null ? `${(bsc.supplyMax / 1e9).toFixed(0)}B` : '—'}`);
    lines.push(`  LP %: ${bsc.lpPctMin ?? '—'}% – ${bsc.lpPctMax ?? '—'}%`);
    lines.push(`  LP USD: $${bsc.lpUsdMin ?? '—'} – $${bsc.lpUsdMax ?? '—'}`);
    lines.push(`  Market cap: $${bsc.mcapUsdMin ?? '—'} – $${bsc.mcapUsdMax ?? '—'}`);
    lines.push(`  Holder filter: ${bsc.holderPctMin !== null || bsc.holderPctMax !== null ? `${bsc.holderPctMin ?? '—'}% – ${bsc.holderPctMax ?? '—'}%` : 'off'}`);
    lines.push(`  Buy alerts: on \\(watching ${(bsc.buyWatchDurationMs / 60000).toFixed(0)} min per token\\)`);
  }

  if (solanaActive.length > 0) {
    lines.push(`🟢 *Solana* — ${solanaActive.join(', ')}`);
  }

  if (lines.length === 0) lines.push('⚠️ No monitors active');

  return lines.join('\n');
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
