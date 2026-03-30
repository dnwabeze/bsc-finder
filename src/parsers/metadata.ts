import axios from 'axios';
import { config } from '../config';

export interface TokenSocials {
  twitter?: string;
  telegram?: string;
  website?: string;
  discord?: string;
}

export interface TokenMetadata {
  name?: string;
  symbol?: string;
  description?: string;
  image?: string;
  socials: TokenSocials;
  uri?: string;
}

export async function fetchMetadata(uri: string): Promise<TokenMetadata> {
  try {
    const response = await axios.get(uri, {
      timeout: config.metadataFetchTimeout,
      headers: { 'Accept': 'application/json' },
    });

    const data = response.data;
    const socials: TokenSocials = {};

    // Extract socials from various possible field formats
    if (data.twitter)   socials.twitter   = normalizeUrl(data.twitter);
    if (data.telegram)  socials.telegram  = normalizeUrl(data.telegram);
    if (data.website)   socials.website   = normalizeUrl(data.website);
    if (data.discord)   socials.discord   = normalizeUrl(data.discord);

    // Some tokens nest socials inside extensions or properties
    if (data.extensions) {
      if (data.extensions.twitter)  socials.twitter  = normalizeUrl(data.extensions.twitter);
      if (data.extensions.telegram) socials.telegram = normalizeUrl(data.extensions.telegram);
      if (data.extensions.website)  socials.website  = normalizeUrl(data.extensions.website);
      if (data.extensions.discord)  socials.discord  = normalizeUrl(data.extensions.discord);
    }

    return {
      name: data.name,
      symbol: data.symbol,
      description: data.description,
      image: data.image,
      socials,
      uri,
    };
  } catch {
    return { socials: {}, uri };
  }
}

function normalizeUrl(url: string): string {
  if (!url) return url;
  url = url.trim();
  if (url && !url.startsWith('http') && !url.startsWith('@')) {
    // bare handle like "mytoken" for twitter
    return url;
  }
  return url;
}
