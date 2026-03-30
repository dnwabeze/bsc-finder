/**
 * Pump.fun transaction parser
 *
 * The pump.fun `create` instruction layout (after the 8-byte discriminator):
 *   name    : string  (4-byte length prefix + UTF-8 bytes)
 *   symbol  : string  (4-byte length prefix + UTF-8 bytes)
 *   uri     : string  (4-byte length prefix + UTF-8 bytes)
 *
 * Discriminator for `create`: [24, 30, 200, 40, 5, 28, 7, 119]  (from pump.fun IDL)
 */

export interface PumpfunCreateEvent {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  creator: string;
  bondingCurve: string;
  signature: string;
}

const CREATE_DISCRIMINATOR = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]);

export function parsePumpfunCreate(
  data: Buffer,
  accounts: string[],
  signature: string
): PumpfunCreateEvent | null {
  try {
    // Check discriminator
    if (data.length < 8) return null;
    if (!data.slice(0, 8).equals(CREATE_DISCRIMINATOR)) return null;

    let offset = 8;

    const readString = (): string => {
      if (offset + 4 > data.length) throw new Error('Buffer overflow reading string length');
      const len = data.readUInt32LE(offset);
      offset += 4;
      if (offset + len > data.length) throw new Error('Buffer overflow reading string data');
      const str = data.slice(offset, offset + len).toString('utf-8');
      offset += len;
      return str;
    };

    const name   = readString();
    const symbol = readString();
    const uri    = readString();

    // Account layout for pump.fun create:
    // 0: mint
    // 1: mintAuthority
    // 2: bondingCurve
    // 3: associatedBondingCurve
    // 4: global
    // 5: mplTokenMetadata
    // 6: metadata
    // 7: user (creator)
    // ...

    const mint         = accounts[0] || '';
    const bondingCurve = accounts[2] || '';
    const creator      = accounts[7] || '';

    return { mint, name, symbol, uri, creator, bondingCurve, signature };
  } catch {
    return null;
  }
}
