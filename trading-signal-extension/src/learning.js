import { analyze, DEFAULT_WEIGHTS, FACTORS } from './analysis.js';
import { fetchCandles, HTF, TF_MS } from './data.js';

export const DEFAULT_SETTINGS = {
  watchlist: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT'],
  timeframe: '15m',
  intervalMin: 5,
  autoScan: false,
  minStrength: 40,
  balance: 100,
  riskPct: 1,
  rr: 2,
  slAtr: 1.5,
  threshold: 0.3,
};

const MAX_BARS = 100;  // এতগুলো ক্যান্ডেলের মধ্যে SL/TP না লাগলে ট্রেড "expired"
const MAX_SIGNALS = 300;
const W_MIN = 0.1, W_MAX = 3;

// ---------- Pure functions (চাইলে Node-এ টেস্ট করা যায়) ----------

/** সিগন্যালের পরের ক্যান্ডেলগুলো দেখে বের করে: আগে TP লেগেছে নাকি SL */
export function resolveTrade(sig, after, maxBars = MAX_BARS) {
  const buy = sig.signal === 'BUY';
  for (let i = 0; i < after.length && i < maxBars; i++) {
    const c = after[i];
    const hitSL = buy ? c.l <= sig.sl : c.h >= sig.sl;
    const hitTP = buy ? c.h >= sig.tp : c.l <= sig.tp;
    // একই ক্যান্ডেলে দুটোই লাগলে নিরাপদ হিসেবে লস ধরা হয়
    if (hitSL) return { result: 'loss', exit: sig.sl, bars: i + 1 };
    if (hitTP) return { result: 'win', exit: sig.tp, bars: i + 1 };
  }
  if (after.length >= maxBars) {
    const exit = after[maxBars - 1].c;
    return { result: 'expired', exit, bars: maxBars };
  }
  return null; // এখনো ফলাফল হয়নি
}

/** ফলাফল অনুযায়ী ফ্যাক্টরের ওজন আপডেট (অনলাইন লার্নিং) */
export function applyOutcome(weights, sig, res, lr) {
  const dir = sig.signal === 'BUY' ? 1 : -1;
  let outcome;
  if (res.result === 'win') outcome = 1;
  else if (res.result === 'loss') outcome = -1;
  else outcome = Math.sign((res.exit - sig.price) * dir) * 0.3;
  const next = { ...weights };
  for (const f of sig.factors) {
    // যে ফ্যাক্টর সঠিক দিকে ভোট দিয়েছিল তার ওজন বাড়ে, ভুল দিকে দিলে কমে
    const delta = lr * outcome * dir * f.vote;
    next[f.key] = Math.min(W_MAX, Math.max(W_MIN, (next[f.key] ?? 1) + delta));
  }
  return next;
}

// ---------- Storage ----------

export async function getState() {
  const s = await chrome.storage.local.get(['settings', 'weights', 'signals', 'stats', 'training']);
  return {
    settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) },
    weights: { ...DEFAULT_WEIGHTS, ...(s.weights || {}) },
    signals: s.signals || [],
    stats: s.stats || { win: 0, loss: 0, expired: 0 },
    training: s.training || null,
  };
}

export async function runAnalysis(symbol, tf) {
  const { settings, weights } = await getState();
  const [ltf, htf] = await Promise.all([
    fetchCandles(symbol, tf, { limit: 300 }),
    fetchCandles(symbol, HTF[tf] || '1d', { limit: 300 }),
  ]);
  const res = analyze(ltf, htf, weights, settings);
  return { ...res, symbol: symbol.toUpperCase(), tf };
}

/** BUY/SELL সিগন্যাল জার্নালে রাখা (একই ক্যান্ডেলের সিগন্যাল দুবার রাখা হয় না) */
export async function recordSignal(res, source = 'manual') {
  if (res.signal === 'WAIT') return false;
  const { signals } = await getState();
  const dup = signals.some((s) => s.symbol === res.symbol && s.tf === res.tf && s.candleTime === res.candleTime);
  if (dup) return false;
  signals.unshift({
    id: `${res.symbol}-${res.tf}-${res.candleTime}`,
    symbol: res.symbol, tf: res.tf, signal: res.signal, price: res.price, sl: res.sl, tp: res.tp,
    strength: res.strength, candleTime: res.candleTime, createdAt: Date.now(), source,
    factors: res.factors.map(({ key, vote }) => ({ key, vote })),
    status: 'pending',
  });
  await chrome.storage.local.set({ signals: signals.slice(0, MAX_SIGNALS) });
  return true;
}

/** অপেক্ষমাণ সিগন্যালগুলোর ফলাফল দেখে শেখা */
export async function evaluatePending() {
  const st = await getState();
  let { weights, stats } = st;
  const signals = st.signals;
  let changed = 0;
  for (const sig of signals) {
    if (sig.status !== 'pending') continue;
    const tfMs = TF_MS[sig.tf];
    if (Date.now() - sig.candleTime < tfMs * 2) continue;
    try {
      const after = await fetchCandles(sig.symbol, sig.tf, { startTime: sig.candleTime + tfMs, limit: MAX_BARS });
      const res = resolveTrade(sig, after);
      if (!res) continue;
      Object.assign(sig, { status: res.result, exit: res.exit, bars: res.bars, resolvedAt: Date.now() });
      weights = applyOutcome(weights, sig, res, 0.1);
      stats = { ...stats, [res.result]: (stats[res.result] || 0) + 1 };
      changed++;
    } catch (e) {
      console.warn('evaluate failed', sig.id, e);
    }
  }
  if (changed) await chrome.storage.local.set({ signals, weights, stats });
  return changed;
}

/**
 * পুরনো ডেটায় walk-forward backtest চালিয়ে ওজন শেখানো।
 * প্রতিটা ক্যান্ডেলে শুধু তখন পর্যন্ত জানা ডেটা দিয়ে সিগন্যাল তৈরি হয়, পরের ক্যান্ডেল দিয়ে ফলাফল যাচাই হয়।
 */
export async function trainOnHistory(symbols, tf, onProgress = () => {}) {
  const st = await getState();
  let weights = st.weights;
  const before = { ...weights };
  const total = { trades: 0, win: 0, loss: 0, expired: 0 };
  const perSymbol = [];
  for (const [n, symbol] of symbols.entries()) {
    onProgress(`${symbol} (${n + 1}/${symbols.length}) ডেটা আনা হচ্ছে...`);
    const [ltf, htf] = await Promise.all([
      fetchCandles(symbol, tf, { limit: 1000 }),
      fetchCandles(symbol, HTF[tf] || '1d', { limit: 1000 }),
    ]);
    const s = { symbol, trades: 0, win: 0, loss: 0, expired: 0 };
    let h = 0;
    for (let i = 250; i < ltf.length - 1; i++) {
      while (h < htf.length && htf[h].ct <= ltf[i].ct) h++;
      const window = ltf.slice(i - 249, i + 1);
      const htfWin = htf.slice(Math.max(0, h - 300), h);
      const res = analyze(window, htfWin, weights, st.settings);
      if (res.signal === 'WAIT') continue;
      const out = resolveTrade(res, ltf.slice(i + 1));
      if (!out) break;
      weights = applyOutcome(weights, res, out, 0.05);
      s.trades++; s[out.result]++;
      i += out.bars; // একটা ট্রেড শেষ না হওয়া পর্যন্ত নতুন ট্রেড নয়
    }
    perSymbol.push(s);
    for (const k of ['trades', 'win', 'loss', 'expired']) total[k] += s[k];
  }
  const training = { at: Date.now(), tf, symbols, total, perSymbol, before, after: weights };
  await chrome.storage.local.set({ weights, training });
  return training;
}

export async function resetLearning() {
  await chrome.storage.local.set({ weights: { ...DEFAULT_WEIGHTS }, stats: { win: 0, loss: 0, expired: 0 }, training: null });
}

export { FACTORS };
