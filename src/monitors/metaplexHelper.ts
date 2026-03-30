import { Connection, PublicKey } from '@solana/web3.js';

const METAPLEX_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

export interface OnchainMetadata {
  name?: string;
  symbol?: string;
  uri?: string;
}

export async function fetchMetaplexMetadataForMint(
  connection: Connection,
  mint: string
): Promise<OnchainMetadata | null> {
  try {
    const mintPubkey = new PublicKey(mint);
    const [metadataPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('metadata'), METAPLEX_PROGRAM.toBuffer(), mintPubkey.toBuffer()],
      METAPLEX_PROGRAM
    );

    const accountInfo = await connection.getAccountInfo(metadataPda, 'confirmed');
    if (!accountInfo) return null;

    return parseMetaplexAccount(accountInfo.data);
  } catch {
    return null;
  }
}

function parseMetaplexAccount(data: Buffer): OnchainMetadata | null {
  try {
    // key(1) + update_authority(32) + mint(32) = 65 bytes header
    let offset = 65;

    const readString = (): string => {
      if (offset + 4 > data.length) return '';
      const len = data.readUInt32LE(offset);
      offset += 4;
      if (offset + len > data.length) return '';
      const str = data.slice(offset, offset + len).toString('utf-8').replace(/\0/g, '').trim();
      offset += len;
      return str;
    };

    const name   = readString();
    const symbol = readString();
    const uri    = readString();

    return { name, symbol, uri };
  } catch {
    return null;
  }
}
