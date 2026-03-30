import { Connection, PublicKey } from '@solana/web3.js';
import { TokenInfo } from './tokenFilter';

/** Fetches total supply and decimals for a token and sets them on the TokenInfo object. */
export async function enrichWithSupply(connection: Connection, token: TokenInfo): Promise<void> {
  try {
    const info = await connection.getTokenSupply(new PublicKey(token.mint), 'confirmed');
    token.supply   = BigInt(info.value.amount);
    token.decimals = info.value.decimals;
  } catch {
    // Non-fatal — mint may not be fully confirmed yet
  }
}
