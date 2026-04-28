import { ethers } from 'ethers';

// WBNB/BUSD pair on PancakeSwap V2 — used as a live BNB/USD oracle
const WBNB_BUSD_PAIR = '0x58F876857a02D6762E0101bb5C46A8c1ED44Dc16';
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const BUSD = '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56';

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

let cachedPrice: number = 0;
let cacheTimestamp: number = 0;
const CACHE_TTL_MS = 60_000; // refresh at most once per minute

export async function getBnbPriceUsd(provider: ethers.JsonRpcProvider): Promise<number> {
  const now = Date.now();
  if (cachedPrice > 0 && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedPrice;
  }

  try {
    const wbnbContract = new ethers.Contract(WBNB, ERC20_ABI, provider);
    const busdContract = new ethers.Contract(BUSD, ERC20_ABI, provider);

    const [wbnbRaw, busdRaw] = await Promise.all([
      wbnbContract.balanceOf(WBNB_BUSD_PAIR),
      busdContract.balanceOf(WBNB_BUSD_PAIR),
    ]);

    // Both WBNB and BUSD have 18 decimals
    const wbnbAmount = Number(wbnbRaw) / 1e18;
    const busdAmount = Number(busdRaw) / 1e18;

    if (wbnbAmount === 0) return cachedPrice || 600;

    cachedPrice = busdAmount / wbnbAmount;
    cacheTimestamp = now;
    return cachedPrice;
  } catch (err: any) {
    console.error('[BSC/BnbPrice] Failed to fetch price:', err?.message);
    return cachedPrice || 600; // fallback to last known price or rough estimate
  }
}
