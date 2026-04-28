import { ethers } from 'ethers';
import { config } from '../../config';

type SubscribeFn = (provider: ethers.WebSocketProvider) => void;

const subscribers: SubscribeFn[] = [];
let provider: ethers.WebSocketProvider | null = null;
let reconnecting = false;
let reconnectDelay = 5_000;
const MAX_RECONNECT_DELAY = 120_000;

export function onWsConnect(fn: SubscribeFn): void {
  subscribers.push(fn);
  if (provider) fn(provider);
}

export function connectBscWs(): void {
  connect();
}

function connect(): void {
  try {
    const p = new ethers.WebSocketProvider(config.bsc.wsEndpoint);

    const ws: any = (p as any)._websocket ?? (p as any).websocket;
    if (ws) {
      if (typeof ws.on === 'function') {
        ws.on('close', () => scheduleReconnect());
        ws.on('error', (e: any) => {
          const msg = e?.message ?? String(e);
          console.error('[BSC/WS] Error:', msg);
          if (msg.includes('429') || msg.includes('401')) scheduleReconnect(true);
        });
      } else if (typeof ws.addEventListener === 'function') {
        ws.addEventListener('close', () => scheduleReconnect());
      }
    }

    provider = p;
    reconnectDelay = 5_000;
    console.log('[BSC/WS] Connected — notifying subscribers...');

    for (const fn of subscribers) {
      try { fn(p); } catch (e: any) {
        console.error('[BSC/WS] Subscriber error:', e?.message);
      }
    }
  } catch (err: any) {
    console.error('[BSC/WS] Connection failed:', err?.message);
    scheduleReconnect();
  }
}

function scheduleReconnect(rateLimited = false): void {
  if (reconnecting) return;
  reconnecting = true;
  provider = null;
  const delay = rateLimited ? Math.max(reconnectDelay, 30_000) : reconnectDelay;
  reconnectDelay = Math.min(delay * 2, MAX_RECONNECT_DELAY);
  console.warn(`[BSC/WS] Disconnected — reconnecting in ${delay / 1000}s...`);
  setTimeout(() => {
    reconnecting = false;
    connect();
  }, delay);
}
