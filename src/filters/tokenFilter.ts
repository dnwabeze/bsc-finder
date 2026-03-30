import { config } from '../config';
import { TokenMetadata } from '../parsers/metadata';

export interface TokenInfo {
  mint: string;
  name: string;
  symbol: string;
  source: 'pumpfun' | 'traditional' | 'raydium';
  launchpad?: string;
  creator?: string;
  bondingCurve?: string;
  signature: string;
  metadata?: TokenMetadata;
  timestamp: number;
  supply?: bigint;
  decimals?: number;
  topHolderPercent?: number;
  top5HolderPercent?: number;
  top10HolderPercent?: number;
}

export function passesFilters(token: TokenInfo): boolean {
  const { filters } = config;
  const socials = token.metadata?.socials || {};

  const label = `${token.symbol || '?'} (${token.mint.slice(0, 8)}…)`;

  // ── Name / ticker match ───────────────────────────────────────────────────
  const nameLC   = (token.name   || '').toLowerCase().replace(/\$/g, '');
  const symbolLC = (token.symbol || '').toLowerCase().replace(/\$/g, '');
  const nameMatches = filters.nameKeywords.length > 0 &&
    filters.nameKeywords.some(kw => {
      const kwClean = kw.replace(/\$/g, '');
      return nameLC.includes(kwClean) || symbolLC.includes(kwClean);
    });

  if (nameMatches) {
    console.log(`[Filter] ✅ ${label} passed — name/ticker matched`);
    return true;
  }

  // ── Social keyword matches ────────────────────────────────────────────────
  const twitterMatches = filters.twitterKeywords.length > 0 && !!socials.twitter &&
    filters.twitterKeywords.some(kw => socials.twitter!.toLowerCase().includes(kw));

  const telegramMatches = filters.telegramKeywords.length > 0 && !!socials.telegram &&
    filters.telegramKeywords.some(kw => socials.telegram!.toLowerCase().includes(kw));

  const websiteMatches = filters.websiteKeywords.length > 0 && !!socials.website &&
    filters.websiteKeywords.some(kw => socials.website!.toLowerCase().includes(kw));

  if (twitterMatches) {
    console.log(`[Filter] ✅ ${label} passed — Twitter matched`);
    return true;
  }
  if (telegramMatches) {
    console.log(`[Filter] ✅ ${label} passed — Telegram matched`);
    return true;
  }
  if (websiteMatches) {
    console.log(`[Filter] ✅ ${label} passed — Website matched`);
    return true;
  }

  // ── Supply match ──────────────────────────────────────────────────────────
  const supplyFilterSet = filters.minSupply !== null || filters.maxSupply !== null;
  if (supplyFilterSet && token.supply !== undefined && token.decimals !== undefined) {
    const supplyHuman = Number(token.supply) / Math.pow(10, token.decimals);
    const aboveMin = filters.minSupply === null || supplyHuman >= filters.minSupply;
    const belowMax = filters.maxSupply === null || supplyHuman <= filters.maxSupply;
    if (aboveMin && belowMax) {
      console.log(`[Filter] ✅ ${label} passed — supply ${supplyHuman.toLocaleString()} matched range`);
      return true;
    }
  }

  // ── Nothing matched — check if any filter was set ─────────────────────────
  const anyFilterSet =
    filters.nameKeywords.length > 0    ||
    filters.twitterKeywords.length > 0 ||
    filters.telegramKeywords.length > 0 ||
    filters.websiteKeywords.length > 0 ||
    supplyFilterSet;

  if (anyFilterSet) {
    console.log(`[Filter] ❌ ${label} — no filter matched, dropping`);
    return false;
  }

  // ── No filters set at all — apply only REQUIRE_SOCIALS ───────────────────
  const isLaunchpad = token.source === 'pumpfun' || !!token.launchpad;
  if (filters.requireSocials && isLaunchpad) {
    const hasSocial = !!(socials.twitter || socials.telegram || socials.website || socials.discord);
    if (!hasSocial) {
      console.log(`[Filter] ❌ ${label} — no socials, dropped`);
      return false;
    }
  }

  console.log(`[Filter] ✅ ${label} passed — no filters set, alerting all`);
  return true;
}
