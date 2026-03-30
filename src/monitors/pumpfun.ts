/**
 * Pump.fun Monitor via Pump Portal WebSocket
 *
 * Uses wss://pumpportal.fun/api/data — subscribes to new token events.
 * Events arrive with name, symbol, socials already included.
 * No transaction fetching needed — much faster and more reliable.
 */

import WebSocket from 'ws';
import { fetchMetadata } from '../parsers/metadata';
import { TokenInfo, passesFilters } from '../filters/tokenFilter';
import { sendTokenAlert } from '../notifiers/telegram';
import { addToWatchlist } from '../watchlist/watchlist';
import { enrichWithSupply } from '../filters/fetchSupply';
import { Connection } from '@solana/web3.js';

const PUMP_PORTAL_WS = 'wss://pumpportal.fun/api/data';
const RECONNECT_DELAY_MS = 5000;

export function startPumpfunMonitor(connection: Connection): void {
  console.log('[Pump.fun] Starting Pump Portal monitor...');
  connect(connection);
}

function connect(connection: Connection): void {
  const ws = new WebSocket(PUMP_PORTAL_WS);

  ws.on('open', () => {
    console.log('[Pump.fun] Connected to Pump Portal');
    // Subscribe to all new token creations
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
  });

  ws.on('message', async (data: WebSocket.RawData) => {
    try {
      const event = JSON.parse(data.toString());

      // Only process token creation events
      if (!event.mint) return;
      if (event.txType && event.txType !== 'create') return;

      await handleNewToken(connection, event);
    } catch {
      // Ignore malformed messages
    }
  });

  ws.on('error', (err) => {
    console.error('[Pump.fun] WebSocket error:', err.message);
  });

  ws.on('close', () => {
    console.log(`[Pump.fun] Disconnected — reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    setTimeout(() => connect(connection), RECONNECT_DELAY_MS);
  });
}

async function handleNewToken(connection: Connection, event: any): Promise<void> {
  try {
    const mint      = event.mint;
    const signature = event.signature || '';
    const creator   = event.traderPublicKey || event.deployer || '';

    // Build token info from event data directly
    const token: TokenInfo = {
      mint,
      name:   event.name   || '',
      symbol: event.symbol || '',
      source: 'pumpfun',
      creator,
      bondingCurve: event.bondingCurveKey || '',
      signature,
      timestamp: Date.now(),
      metadata: {
        name:        event.name,
        symbol:      event.symbol,
        description: event.description,
        image:       event.image,
        uri:         event.uri,
        socials: {
          twitter:  event.twitter  || undefined,
          telegram: event.telegram || undefined,
          website:  event.website  || undefined,
        },
      },
    };

    // If a metadata URI is present and socials are missing, fetch them
    const hasSocials = !!(token.metadata?.socials?.twitter ||
                          token.metadata?.socials?.telegram ||
                          token.metadata?.socials?.website);

    if (!hasSocials && event.uri) {
      const fetched = await fetchMetadata(event.uri);
      token.metadata = fetched;
      if (!token.name   && fetched.name)   token.name   = fetched.name;
      if (!token.symbol && fetched.symbol) token.symbol = fetched.symbol;
    }

    console.log(`[Pump.fun] New token: ${token.symbol} | ${mint}`);

    await enrichWithSupply(connection, token);

    if (!passesFilters(token)) {
      console.log(`[Pump.fun] Filtered out: ${token.symbol}`);
      return;
    }

    if (!addToWatchlist(token)) return;
    await sendTokenAlert(token);

  } catch (err: any) {
    console.error('[Pump.fun] Error handling token:', err?.message);
  }
}
