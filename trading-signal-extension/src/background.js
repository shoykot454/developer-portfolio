import { getState, runAnalysis, recordSignal, evaluatePending, trainOnHistory, resetLearning, DEFAULT_SETTINGS } from './learning.js';

const fmt = (n) => (Math.abs(n) >= 100 ? n.toFixed(2) : Math.abs(n) >= 1 ? n.toFixed(4) : n.toPrecision(4));

async function scheduleAlarm() {
  const { settings } = await getState();
  await chrome.alarms.clear('scan');
  if (settings.autoScan) {
    chrome.alarms.create('scan', { periodInMinutes: Math.max(1, Number(settings.intervalMin) || 5) });
  }
}

async function runScan() {
  const { settings } = await getState();
  const found = [];
  for (const symbol of settings.watchlist) {
    try {
      const res = await runAnalysis(symbol, settings.timeframe);
      if (res.signal !== 'WAIT' && res.strength >= settings.minStrength) {
        const isNew = await recordSignal(res, 'auto');
        if (isNew) {
          found.push(res);
          chrome.notifications.create(`sig-${res.symbol}-${res.candleTime}`, {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon128.png'),
            title: `${res.signal === 'BUY' ? '🟢 BUY' : '🔴 SELL'} ${res.symbol} (${res.tf})`,
            message: `দাম ${fmt(res.price)} | SL ${fmt(res.sl)} | TP ${fmt(res.tp)} | শক্তি ${res.strength}%`,
            priority: 1,
          });
        }
      }
    } catch (e) {
      console.warn('scan failed', symbol, e);
    }
  }
  if (found.length) {
    chrome.action.setBadgeText({ text: String(found.length) });
    chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  }
  await evaluatePending();
  return found.length;
}

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  await scheduleAlarm();
});
chrome.runtime.onStartup.addListener(scheduleAlarm);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'scan') runScan(); });

async function handle(msg) {
  switch (msg.type) {
    case 'analyze': {
      const res = await runAnalysis(msg.symbol, msg.tf);
      await recordSignal(res, 'manual');
      return res;
    }
    case 'scanNow': return { found: await runScan() };
    case 'evaluate': return { changed: await evaluatePending() };
    case 'train': return trainOnHistory(msg.symbols, msg.tf, (text) => chrome.runtime.sendMessage({ type: 'progress', text }).catch(() => {}));
    case 'settingsChanged': await scheduleAlarm(); return { ok: true };
    case 'reset': await resetLearning(); return { ok: true };
    case 'clearJournal': await chrome.storage.local.set({ signals: [] }); return { ok: true };
    default: throw new Error('Unknown message');
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'progress') return false;
  handle(msg).then(sendResponse).catch((e) => sendResponse({ error: e.message }));
  return true;
});
