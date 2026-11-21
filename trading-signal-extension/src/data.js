// Binance-এর পাবলিক মার্কেট ডেটা (কোনো API key লাগে না)
const BASES = ['https://data-api.binance.vision', 'https://api.binance.com'];

export const TF_MS = {
  '1m': 60e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3,
  '1h': 3600e3, '4h': 14400e3, '1d': 86400e3, '1w': 604800e3,
};

// প্রতিটা টাইমফ্রেমের জন্য কোন বড় টাইমফ্রেমে ট্রেন্ড দেখা হবে
export const HTF = { '1m': '15m', '5m': '1h', '15m': '4h', '30m': '4h', '1h': '1d', '4h': '1d', '1d': '1w' };

export async function fetchCandles(symbol, interval, { limit = 500, startTime, includeOpen = false } = {}) {
  let lastErr;
  for (const base of BASES) {
    try {
      const u = new URL('/api/v3/klines', base);
      u.searchParams.set('symbol', symbol.toUpperCase().trim());
      u.searchParams.set('interval', interval);
      u.searchParams.set('limit', String(Math.min(limit, 1000)));
      if (startTime) u.searchParams.set('startTime', String(startTime));
      const r = await fetch(u);
      if (r.status === 400) throw Object.assign(new Error(`"${symbol}" পেয়ার পাওয়া যায়নি (যেমন: BTCUSDT লিখুন)`), { fatal: true });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const raw = await r.json();
      const now = Date.now();
      let candles = raw.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], ct: k[6] }));
      if (!includeOpen) candles = candles.filter((c) => c.ct < now);
      return candles;
    } catch (e) {
      lastErr = e;
      if (e.fatal) break;
    }
  }
  throw new Error(`ডেটা আনা যায়নি: ${lastErr?.message || 'নেটওয়ার্ক সমস্যা'}`);
}
