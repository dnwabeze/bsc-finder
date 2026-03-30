import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';
import { TokenInfo } from '../filters/tokenFilter';

let bot: TelegramBot;

export function initTelegram(): void {
  bot = new TelegramBot(config.telegram.botToken, { polling: false });
  console.log('[Telegram] Bot initialized');
}

// ── Stage 1: Token Detected ──────────────────────────────────────────────────
export async function sendTokenAlert(token: TokenInfo): Promise<void> {
  if (!bot) return;

  const socials  = token.metadata?.socials || {};
  const sourceLabel = getSourceLabel(token);

  const socialLinks: string[] = [];
  if (socials.twitter)  socialLinks.push(`[Twitter](${toTwitterUrl(socials.twitter)})`);
  if (socials.telegram) socialLinks.push(`[Telegram](${toTelegramUrl(socials.telegram)})`);
  if (socials.website)  socialLinks.push(`[Website](${socials.website})`);
  if (socials.discord)  socialLinks.push(`[Discord](${socials.discord})`);

  const socialsLine = socialLinks.length > 0 ? socialLinks.join('  |  ') : '_No socials_';

  const desc = token.metadata?.description
    ? `\n📝 ${esc(token.metadata.description.slice(0, 180))}${token.metadata.description.length > 180 ? '…' : ''}`
    : '';

  const msg = [
    `🟢 *STAGE 1 — TOKEN CREATED*`,
    `${sourceLabel}`,
    ``,
    `🪙 *Name:*   ${esc(token.name   || 'Unknown')}`,
    `🔤 *Symbol:* ${esc(token.symbol || 'Unknown')}`,
    `📍 *Mint:* \`${token.mint}\``,
    token.creator ? `👤 *Creator:* \`${token.creator}\`` : '',
    desc,
    ``,
    `🌐 *Socials:* ${socialsLine}`,
    ``,
    `🔗 ${links(token)}`,
    ``,
    `👁️ _Now watching for distribution…_`,
    ``,
    `📋 [${token.signature.slice(0, 16)}…](https://solscan.io/tx/${token.signature})`,
    `⏰ ${new Date(token.timestamp).toUTCString()}`,
  ].filter(l => l !== '').join('\n');

  await send(msg);
}

// ── Stage 2: Distribution Started ────────────────────────────────────────────
export async function sendDistributionAlert(
  token: TokenInfo,
  distribution: number[],
  holderCount: number,
  totalSupply: bigint,
  decimals: number
): Promise<void> {
  if (!bot) return;

  const supplyHuman = formatSupply(totalSupply, decimals);
  const topRows = distribution.slice(0, 10).map((pct, i) =>
    `  ${i + 1}. ${pct.toFixed(2)}%`
  ).join('\n');

  const msg = [
    `🟡 *STAGE 2 — DISTRIBUTION DETECTED*`,
    `🪙 ${esc(token.name)} (${esc(token.symbol)})`,
    `📍 \`${token.mint}\``,
    ``,
    `📊 *Total Supply:* ${supplyHuman}`,
    `👥 *Holders detected:* ${holderCount}`,
    ``,
    `📈 *Top ${Math.min(10, distribution.length)} holder breakdown:*`,
    topRows,
    ``,
    `🔗 ${links(token)}`,
    ``,
    `👁️ _Checking if distribution matches your pattern…_`,
  ].join('\n');

  await send(msg);
}

// ── Stage 3: Pattern Matched ──────────────────────────────────────────────────
export async function sendPatternMatchAlert(
  token: TokenInfo,
  distribution: number[],
  holderCount: number,
  totalSupply: bigint,
  decimals: number
): Promise<void> {
  if (!bot) return;

  const supplyHuman = formatSupply(totalSupply, decimals);
  const pattern     = config.distribution.pattern;
  const tolerance   = config.distribution.tolerance;

  const comparisonRows = pattern.map((target, i) => {
    const actual = distribution[i] ?? 0;
    const diff   = (actual - target).toFixed(2);
    const arrow  = actual >= target ? '▲' : '▼';
    return `  ${i + 1}. Target ${target}%  →  Actual ${actual.toFixed(2)}%  ${arrow}${Math.abs(actual - target).toFixed(2)}%`;
  }).join('\n');

  const msg = [
    `🔴 *STAGE 3 — PATTERN MATCHED* ✅`,
    `🪙 ${esc(token.name)} (${esc(token.symbol)})`,
    `📍 \`${token.mint}\``,
    ``,
    `📊 *Total Supply:* ${supplyHuman}`,
    `👥 *Holders:* ${holderCount}`,
    `⚖️ *Tolerance:* ±${tolerance}%`,
    ``,
    `🎯 *Distribution vs Your Pattern:*`,
    comparisonRows,
    ``,
    `🔗 ${links(token)}`,
  ].join('\n');

  await send(msg);
}

// ── Status ────────────────────────────────────────────────────────────────────
export async function sendStatusMessage(text: string): Promise<void> {
  if (!bot) return;
  await send(text);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function send(text: string): Promise<void> {
  try {
    await bot.sendMessage(config.telegram.chatId, text, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
  } catch (err: any) {
    console.error('[Telegram] Send failed:', err?.message);
  }
}

function links(token: TokenInfo): string {
  const parts = [
    `[Solscan](https://solscan.io/token/${token.mint})`,
    `[Dexscreener](https://dexscreener.com/solana/${token.mint})`,
    `[Birdeye](https://birdeye.so/token/${token.mint})`,
  ];
  if (token.source === 'pumpfun') {
    parts.push(`[Pump.fun](https://pump.fun/${token.mint})`);
  }
  return parts.join('  |  ');
}

function getSourceLabel(token: TokenInfo): string {
  if (token.launchpad) return `📦 *${esc(token.launchpad)}*`;
  return {
    pumpfun:     '🚀 *Pump.fun*',
    traditional: '🏗️ *Traditional SPL*',
    raydium:     '⚡ *Raydium*',
  }[token.source] || '🔷 *Solana*';
}

function formatSupply(supply: bigint, decimals: number): string {
  const n = Number(supply) / Math.pow(10, decimals);
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9)  return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6)  return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3)  return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(2);
}

function toTwitterUrl(handle: string): string {
  if (handle.startsWith('http')) return handle;
  return `https://twitter.com/${handle.replace('@', '')}`;
}

function toTelegramUrl(handle: string): string {
  if (handle.startsWith('http')) return handle;
  return `https://t.me/${handle.replace('@', '')}`;
}

function esc(text: string): string {
  return (text || '').replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}
