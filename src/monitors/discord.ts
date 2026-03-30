/**
 * Discord Monitor
 *
 * Watches specified Discord channels for Solana contract address drops.
 * CA is typically posted on Discord first — before Telegram and Twitter.
 * Fires an immediate Telegram alert the moment a Solana address is detected.
 *
 * Setup:
 *  1. Go to https://discord.com/developers/applications → New Application → Bot
 *  2. Enable "Message Content Intent" under Privileged Gateway Intents
 *  3. Copy the bot token → DISCORD_BOT_TOKEN in .env
 *  4. Invite bot: OAuth2 → URL Generator → bot scope → Read Messages + Read Message History
 *  5. In Discord: Settings → Advanced → Developer Mode ON
 *     Right-click the channel → Copy Channel ID → DISCORD_CHANNEL_IDS in .env
 */

import { Client, GatewayIntentBits, Events, Message, TextChannel } from 'discord.js';
import { config } from '../config';
import { sendDiscordCaAlert } from '../notifiers/telegram';

// Solana base58 address: 32–44 chars from base58 alphabet
const SOLANA_ADDRESS_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

// Well-known program IDs to skip — these aren't CAs
const SKIP_ADDRESSES = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  '11111111111111111111111111111111',
  'So11111111111111111111111111111111111111112',
  'SysvarRent111111111111111111111111111111111',
  'SysvarC1ock11111111111111111111111111111111',
  'ComputeBudget111111111111111111111111111111',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bv',
]);

// Don't re-alert the same address
const alerted = new Set<string>();

export function startDiscordMonitor(): void {
  if (!config.discord.botToken) {
    console.log('[Discord] Skipped — DISCORD_BOT_TOKEN not set');
    return;
  }
  if (config.discord.channelIds.length === 0) {
    console.log('[Discord] Skipped — DISCORD_CHANNEL_IDS not set');
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`[Discord] ✅ Logged in as ${c.user.tag}`);
    console.log(`[Discord] Watching channel(s): ${config.discord.channelIds.join(', ')}`);
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    // Only watch configured channels
    if (!config.discord.channelIds.includes(message.channelId)) return;
    // Skip bots and system messages
    if (message.author.bot) return;
    if (!message.content) return;

    const matches = message.content.match(SOLANA_ADDRESS_RE) ?? [];
    const newAddresses = [...new Set(matches)].filter(
      addr => !SKIP_ADDRESSES.has(addr) && !alerted.has(addr)
    );

    for (const address of newAddresses) {
      alerted.add(address);

      const channelName = (message.channel as TextChannel).name ?? message.channelId;
      const preview = message.content.length > 280
        ? message.content.slice(0, 280) + '…'
        : message.content;

      console.log(`[Discord] 🚨 CA detected in #${channelName} by ${message.author.username}: ${address}`);
      await sendDiscordCaAlert(address, message.author.username, preview, channelName);
    }
  });

  client.on('error', (err: Error) => {
    console.error('[Discord] Client error:', err.message);
  });

  client.on('warn', (info: string) => {
    console.warn('[Discord] Warning:', info);
  });

  client.login(config.discord.botToken).catch((err: Error) => {
    console.error('[Discord] Login failed:', err.message);
    console.error('[Discord] Check DISCORD_BOT_TOKEN and that Message Content Intent is enabled');
  });
}
