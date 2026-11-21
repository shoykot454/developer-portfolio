import { ema, rsi, macd, bollinger, atr, swings } from './indicators.js';

// প্রতিটা ফ্যাক্টর -1 (Sell) থেকে +1 (Buy) এর মধ্যে একটা ভোট দেয়।
// শেখার সিস্টেম প্রতিটা ফ্যাক্টরের ওজন (weight) বাড়ায় বা কমায়।
export const FACTORS = {
  htfTrend: 'বড় টাইমফ্রেমের ট্রেন্ড',
  structure: 'মার্কেট স্ট্রাকচার',
  emaCross: 'EMA ৯/২১',
  macd: 'MACD',
  rsi: 'RSI',
  bollinger: 'Bollinger Bands',
  srZone: 'সাপোর্ট/রেজিস্ট্যান্স',
  candle: 'ক্যান্ডেলস্টিক প্যাটার্ন',
  volume: 'ভলিউম',
};

export const DEFAULT_WEIGHTS = Object.fromEntries(Object.keys(FACTORS).map((k) => [k, 1]));

const last = (a) => a[a.length - 1];
const prev = (a) => a[a.length - 2];
const fmt = (n) => (Math.abs(n) >= 100 ? n.toFixed(2) : Math.abs(n) >= 1 ? n.toFixed(4) : n.toPrecision(4));

function voteHtfTrend(htf) {
  if (!htf || htf.length < 60) return { vote: 0, reason: 'বড় টাইমফ্রেমের যথেষ্ট ডেটা নেই' };
  const closes = htf.map((c) => c.c);
  const e50 = last(ema(closes, 50));
  const e200 = last(ema(closes, Math.min(200, closes.length - 1)));
  const p = last(closes);
  if (p > e50 && e50 > e200) return { vote: 1, reason: 'দাম EMA50 আর EMA200-এর উপরে, শক্ত Uptrend' };
  if (p < e50 && e50 < e200) return { vote: -1, reason: 'দাম EMA50 আর EMA200-এর নিচে, শক্ত Downtrend' };
  if (e50 > e200) return { vote: 0.4, reason: 'EMA50 > EMA200, তবে দাম কিছুটা দুর্বল' };
  return { vote: -0.4, reason: 'EMA50 < EMA200, তবে দাম কিছুটা শক্ত' };
}

function voteStructure(candles) {
  const { highs, lows } = swings(candles.slice(-120), 3);
  if (highs.length < 2 || lows.length < 2) return { vote: 0, reason: 'যথেষ্ট swing পাওয়া যায়নি' };
  const hh = last(highs).price > prev(highs).price;
  const hl = last(lows).price > prev(lows).price;
  const vote = ((hh ? 1 : -1) + (hl ? 1 : -1)) / 2;
  const txt = `${hh ? 'Higher High' : 'Lower High'} + ${hl ? 'Higher Low' : 'Lower Low'}`;
  return { vote, reason: vote > 0 ? `${txt}, Uptrend স্ট্রাকচার` : vote < 0 ? `${txt}, Downtrend স্ট্রাকচার` : `${txt}, মিশ্র/রেঞ্জ` };
}

function voteEma(closes) {
  const e9 = ema(closes, 9), e21 = ema(closes, 21);
  const up = last(e9) > last(e21), wasUp = prev(e9) > prev(e21);
  if (up && !wasUp) return { vote: 1, reason: 'EMA9 এইমাত্র EMA21-এর উপরে ক্রস করেছে' };
  if (!up && wasUp) return { vote: -1, reason: 'EMA9 এইমাত্র EMA21-এর নিচে ক্রস করেছে' };
  return up ? { vote: 0.6, reason: 'EMA9 > EMA21 (শর্ট-টার্ম Bullish)' } : { vote: -0.6, reason: 'EMA9 < EMA21 (শর্ট-টার্ম Bearish)' };
}

function voteMacd(closes) {
  const { hist } = macd(closes);
  const h1 = last(hist), h0 = prev(hist);
  if (Number.isNaN(h1) || Number.isNaN(h0)) return { vote: 0, reason: 'ডেটা কম' };
  if (h0 <= 0 && h1 > 0) return { vote: 1, reason: 'MACD Bullish crossover' };
  if (h0 >= 0 && h1 < 0) return { vote: -1, reason: 'MACD Bearish crossover' };
  if (h1 > 0) return h1 > h0 ? { vote: 0.6, reason: 'Histogram পজিটিভ ও বাড়ছে' } : { vote: 0.2, reason: 'Histogram পজিটিভ কিন্তু কমছে' };
  return h1 < h0 ? { vote: -0.6, reason: 'Histogram নেগেটিভ ও আরও কমছে' } : { vote: -0.2, reason: 'Histogram নেগেটিভ কিন্তু দুর্বল হচ্ছে' };
}

function voteRsi(closes) {
  const r = last(rsi(closes, 14));
  const t = `RSI ${r.toFixed(1)}`;
  if (r < 30) return { vote: 1, reason: `${t}, Oversold (বেশি বিক্রি হয়েছে)`, value: r };
  if (r < 40) return { vote: 0.4, reason: `${t}, Oversold-এর কাছাকাছি`, value: r };
  if (r > 70) return { vote: -1, reason: `${t}, Overbought (বেশি কেনা হয়েছে)`, value: r };
  if (r > 60) return { vote: -0.4, reason: `${t}, Overbought-এর কাছাকাছি`, value: r };
  return { vote: 0, reason: `${t}, নিরপেক্ষ`, value: r };
}

function voteBollinger(closes) {
  const { upper, lower } = bollinger(closes);
  const p = last(closes), u = last(upper), l = last(lower);
  const pb = (p - l) / (u - l);
  if (p < l) return { vote: 1, reason: 'দাম নিচের band-এর বাইরে' };
  if (p > u) return { vote: -1, reason: 'দাম উপরের band-এর বাইরে' };
  if (pb < 0.2) return { vote: 0.4, reason: 'দাম নিচের band-এর কাছে' };
  if (pb > 0.8) return { vote: -0.4, reason: 'দাম উপরের band-এর কাছে' };
  return { vote: 0, reason: 'দাম band-এর মাঝখানে' };
}

function voteSR(candles, atrNow) {
  const recent = candles.slice(-150);
  const { highs, lows } = swings(recent, 3);
  const p = last(candles).c;
  const levels = [...highs, ...lows].map((s) => s.price);
  const supports = levels.filter((x) => x < p);
  const resists = levels.filter((x) => x > p);
  const sup = supports.length ? Math.max(...supports) : null;
  const res = resists.length ? Math.min(...resists) : null;
  const dS = sup != null ? (p - sup) / atrNow : Infinity;
  const dR = res != null ? (res - p) / atrNow : Infinity;
  const info = { support: sup, resistance: res };
  if (dS < 0.7 && dR > 1.5) return { vote: 1, reason: `সাপোর্টের (${fmt(sup)}) কাছে, উপরে জায়গা আছে`, ...info };
  if (dR < 0.7 && dS > 1.5) return { vote: -1, reason: `রেজিস্ট্যান্সের (${fmt(res)}) কাছে, নিচে জায়গা আছে`, ...info };
  if (dS < 0.7 && dR < 0.7) return { vote: 0, reason: 'সাপোর্ট আর রেজিস্ট্যান্স দুটোই কাছে, সরু রেঞ্জ', ...info };
  return { vote: 0, reason: 'কোনো গুরুত্বপূর্ণ লেভেলের কাছে নেই', ...info };
}

function voteCandle(candles, closes) {
  const a = prev(candles), b = last(candles);
  const body = Math.abs(b.c - b.o), range = b.h - b.l || 1e-12;
  const upper = b.h - Math.max(b.o, b.c), lower = Math.min(b.o, b.c) - b.l;
  const e21 = last(ema(closes, 21));
  if (a.c < a.o && b.c > b.o && b.c >= a.o && b.o <= a.c) return { vote: 1, reason: 'Bullish Engulfing' };
  if (a.c > a.o && b.c < b.o && b.c <= a.c && b.o >= a.o) return { vote: -1, reason: 'Bearish Engulfing' };
  if (body / range < 0.1) return { vote: 0, reason: 'Doji, মার্কেট অনিশ্চিত' };
  if (lower >= 2 * body && upper <= body * 0.6) return { vote: b.c < e21 ? 1 : 0.6, reason: 'Hammer / Bullish Pin bar' };
  if (upper >= 2 * body && lower <= body * 0.6) return { vote: b.c > e21 ? -1 : -0.6, reason: 'Shooting Star / Bearish Pin bar' };
  return { vote: 0, reason: 'বিশেষ কোনো প্যাটার্ন নেই' };
}

function voteVolume(candles) {
  const vols = candles.slice(-21, -1).map((c) => c.v);
  const avg = vols.reduce((a, b) => a + b, 0) / (vols.length || 1);
  const b = last(candles);
  if (avg > 0 && b.v > 1.5 * avg) {
    return b.c >= b.o
      ? { vote: 0.8, reason: `গড়ের ${(b.v / avg).toFixed(1)}x ভলিউম, Buyer-রা শক্তিশালী` }
      : { vote: -0.8, reason: `গড়ের ${(b.v / avg).toFixed(1)}x ভলিউম, Seller-রা শক্তিশালী` };
  }
  return { vote: 0, reason: 'স্বাভাবিক ভলিউম' };
}

/**
 * candles: শুধু বন্ধ হওয়া ক্যান্ডেল (ছোট টাইমফ্রেম), htf: বড় টাইমফ্রেমের ক্যান্ডেল
 * settings: { threshold, rr, slAtr, balance, riskPct }
 */
export function analyze(candles, htf, weights = DEFAULT_WEIGHTS, settings = {}) {
  if (!candles || candles.length < 60) throw new Error('অ্যানালাইসিসের জন্য অন্তত ৬০টা ক্যান্ডেল দরকার');
  const { threshold = 0.3, rr = 2, slAtr = 1.5, balance = 100, riskPct = 1 } = settings;
  const closes = candles.map((c) => c.c);
  const atrNow = last(atr(candles, 14));
  const price = last(closes);

  const raw = {
    htfTrend: voteHtfTrend(htf),
    structure: voteStructure(candles),
    emaCross: voteEma(closes),
    macd: voteMacd(closes),
    rsi: voteRsi(closes),
    bollinger: voteBollinger(closes),
    srZone: voteSR(candles, atrNow),
    candle: voteCandle(candles, closes),
    volume: voteVolume(candles),
  };

  let num = 0, den = 0;
  const factors = Object.keys(FACTORS).map((key) => {
    const w = weights[key] ?? 1;
    num += w * raw[key].vote;
    den += w;
    return { key, name: FACTORS[key], vote: raw[key].vote, weight: w, reason: raw[key].reason };
  });
  const score = den ? num / den : 0;

  // বড় ট্রেন্ডের বিপরীতে ট্রেড নিতে হলে আরও শক্ত সিগন্যাল লাগবে
  const htfVote = raw.htfTrend.vote;
  const against = (score > 0 && htfVote < 0) || (score < 0 && htfVote > 0);
  const th = threshold + (against ? 0.15 : 0);
  const signal = score >= th ? 'BUY' : score <= -th ? 'SELL' : 'WAIT';

  const slDist = atrNow * slAtr;
  const dir = signal === 'SELL' ? -1 : 1;
  const sl = price - dir * slDist;
  const tp = price + dir * slDist * rr;
  const riskAmount = (balance * riskPct) / 100;
  const qty = slDist > 0 ? riskAmount / slDist : 0;

  return {
    signal,
    score,
    strength: Math.round(Math.abs(score) * 100),
    againstTrend: against,
    price,
    atr: atrNow,
    sl,
    tp,
    rr,
    riskAmount,
    qty,
    support: raw.srZone.support,
    resistance: raw.srZone.resistance,
    rsi: raw.rsi.value,
    candleTime: last(candles).t,
    factors,
  };
}
