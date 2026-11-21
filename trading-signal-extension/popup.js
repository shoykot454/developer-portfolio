import { FACTORS } from './src/analysis.js';
import { getState, DEFAULT_SETTINGS } from './src/learning.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => (n == null || Number.isNaN(n) ? '—' : Math.abs(n) >= 100 ? n.toFixed(2) : Math.abs(n) >= 1 ? n.toFixed(4) : n.toPrecision(4));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const send = (msg) => chrome.runtime.sendMessage(msg).then((r) => { if (r?.error) throw new Error(r.error); return r; });

// ---------- Tabs ----------
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${t.dataset.tab}`));
  if (t.dataset.tab === 'learn') renderLearn();
  if (t.dataset.tab === 'journal') renderJournal();
}));
chrome.action.setBadgeText({ text: '' });

// ---------- Signal ----------
async function doAnalyze() {
  const btn = $('analyzeBtn');
  btn.disabled = true;
  $('result').innerHTML = '<p class="hint">অ্যানালাইসিস হচ্ছে...</p>';
  try {
    const r = await send({ type: 'analyze', symbol: $('symbol').value.trim(), tf: $('tf').value });
    renderResult(r);
  } catch (e) {
    $('result').innerHTML = `<p class="err">${esc(e.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
}

function renderResult(r) {
  const color = r.signal === 'BUY' ? 'var(--buy)' : r.signal === 'SELL' ? 'var(--sell)' : 'var(--wait)';
  const label = { BUY: 'BUY ▲', SELL: 'SELL ▼', WAIT: 'WAIT ⏸' }[r.signal];
  const trade = r.signal !== 'WAIT' ? `
    <div class="kv">
      <div><span>Entry</span><b>${fmt(r.price)}</b></div>
      <div><span>R:R</span><b>1:${r.rr}</b></div>
      <div><span>Stop-loss</span><b class="neg">${fmt(r.sl)}</b></div>
      <div><span>Take-profit</span><b class="pos">${fmt(r.tp)}</b></div>
      <div><span>ঝুঁকি</span><b>$${r.riskAmount.toFixed(2)}</b></div>
      <div><span>পরিমাণ</span><b>${fmt(r.qty)}</b></div>
    </div>` : `<p class="hint" style="margin:8px 0 0">যথেষ্ট ফ্যাক্টর একমত না। এই মুহূর্তে ট্রেড না নেওয়াই ভালো।</p>`;
  const factors = r.factors.map((f) => {
    const cls = f.vote > 0.05 ? 'pos' : f.vote < -0.05 ? 'neg' : 'neu';
    const icon = f.vote > 0.05 ? '▲' : f.vote < -0.05 ? '▼' : '•';
    return `<div class="factor"><span class="${cls}">${icon}</span><span class="name">${esc(f.name)}</span>
      <span class="v ${cls}">${f.vote > 0 ? '+' : ''}${f.vote.toFixed(1)} × ${f.weight.toFixed(2)}</span>
      <span class="why">${esc(f.reason)}</span></div>`;
  }).join('');
  $('result').innerHTML = `
    <div class="card">
      <div class="sig-head">
        <span class="sig ${r.signal}">${label}</span>
        <span class="hint">${esc(r.symbol)} · ${esc(r.tf)}<br>দাম ${fmt(r.price)}</span>
      </div>
      <div class="meter"><i style="width:${r.strength}%;background:${color}"></i></div>
      <div class="hint">সিগন্যাল শক্তি ${r.strength}% (score ${r.score.toFixed(2)})</div>
      ${r.againstTrend && r.signal !== 'WAIT' ? '<div class="warn">⚠️ বড় টাইমফ্রেমের ট্রেন্ডের বিপরীতে, ঝুঁকি বেশি</div>' : ''}
      ${trade}
      <div class="kv" style="margin-top:6px">
        <div><span>সাপোর্ট</span><b>${fmt(r.support)}</b></div>
        <div><span>রেজিস্ট্যান্স</span><b>${fmt(r.resistance)}</b></div>
      </div>
    </div>
    <h3>কেন এই সিগন্যাল</h3>
    <div class="card">${factors}</div>`;
}
$('analyzeBtn').addEventListener('click', doAnalyze);
$('symbol').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAnalyze(); });

// ---------- Learning ----------
async function renderLearn() {
  const { weights, stats, training } = await getState();
  const done = stats.win + stats.loss;
  const wr = done ? Math.round((stats.win / done) * 100) : null;
  $('stats').innerHTML = [
    ['জয়', stats.win], ['হার', stats.loss], ['মেয়াদোত্তীর্ণ', stats.expired], ['Win rate', wr == null ? '—' : `${wr}%`],
  ].map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('');
  $('weights').innerHTML = Object.entries(FACTORS).map(([k, name]) => {
    const w = weights[k] ?? 1;
    return `<div class="wrow"><span>${esc(name)}</span><span class="wbar"><i style="width:${(w / 3) * 100}%"></i></span><span>${w.toFixed(2)}</span></div>`;
  }).join('');
  if (training) renderTraining(training);
}

function renderTraining(t) {
  const d = t.total.win + t.total.loss;
  const wr = d ? ((t.total.win / d) * 100).toFixed(1) : '—';
  const be = (100 / (1 + (Number($('s-rr').value) || 2))).toFixed(1);
  const rows = t.perSymbol.map((s) => {
    const dd = s.win + s.loss;
    return `<tr><td>${esc(s.symbol)}</td><td>${s.trades}</td><td>${s.win}</td><td>${s.loss}</td><td>${dd ? Math.round((s.win / dd) * 100) + '%' : '—'}</td></tr>`;
  }).join('');
  $('trainOut').innerHTML = `
    <p>শেষ ট্রেনিং: ${new Date(t.at).toLocaleString()} · ${esc(t.tf)}<br>
    মোট ${t.total.trades} ট্রেড, Win rate <b>${wr}%</b> (এই R:R-এ লাভে থাকতে ~${be}%-এর বেশি লাগবে)</p>
    <table><tr><th>পেয়ার</th><th>ট্রেড</th><th>জয়</th><th>হার</th><th>Win%</th></tr>${rows}</table>`;
}

const update1mWarn = () => { $('tf1mWarn').hidden = $('trainTf').value !== '1m'; };
$('trainTf').addEventListener('change', update1mWarn);

$('trainBtn').addEventListener('click', async () => {
  const btn = $('trainBtn');
  btn.disabled = true;
  $('trainOut').textContent = 'শুরু হচ্ছে...';
  try {
    const { settings } = await getState();
    const t = await send({ type: 'train', symbols: settings.watchlist, tf: $('trainTf').value });
    await renderLearn();
    renderTraining(t);
  } catch (e) {
    $('trainOut').innerHTML = `<span class="err">${esc(e.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
});
chrome.runtime.onMessage.addListener((m) => { if (m.type === 'progress') $('trainOut').textContent = m.text; });
$('resetBtn').addEventListener('click', async () => {
  if (!confirm('সব শেখা ওজন আর পরিসংখ্যান মুছে যাবে। নিশ্চিত?')) return;
  await send({ type: 'reset' });
  $('trainOut').textContent = '';
  renderLearn();
});

// ---------- Journal ----------
async function renderJournal() {
  const { signals } = await getState();
  if (!signals.length) { $('journal').innerHTML = '<p class="hint">এখনো কোনো BUY/SELL সিগন্যাল নেই।</p>'; return; }
  const label = { pending: 'অপেক্ষমাণ', win: 'TP ✓', loss: 'SL ✗', expired: 'মেয়াদ শেষ' };
  $('journal').innerHTML = `<table>
    <tr><th>সময়</th><th>পেয়ার</th><th>দিক</th><th>Entry</th><th>ফল</th></tr>
    ${signals.map((s) => `<tr>
      <td>${new Date(s.candleTime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
      <td>${esc(s.symbol)}<br><span class="hint">${esc(s.tf)} · ${s.source === 'auto' ? 'অটো' : 'ম্যানুয়াল'}</span></td>
      <td class="${s.signal === 'BUY' ? 'pos' : 'neg'}">${s.signal}</td>
      <td>${fmt(s.price)}</td>
      <td><span class="badge ${s.status}">${label[s.status]}</span></td></tr>`).join('')}
  </table>`;
}
$('evalBtn').addEventListener('click', async () => { await send({ type: 'evaluate' }); renderJournal(); });
$('clearBtn').addEventListener('click', async () => {
  if (!confirm('জার্নালের সব সিগন্যাল মুছে যাবে। নিশ্চিত?')) return;
  await send({ type: 'clearJournal' });
  renderJournal();
});

// ---------- Settings ----------
const NUM_KEYS = ['intervalMin', 'minStrength', 'threshold', 'balance', 'riskPct', 'rr', 'slAtr'];
async function loadSettings() {
  const { settings } = await getState();
  $('s-watchlist').value = settings.watchlist.join(', ');
  $('s-timeframe').value = settings.timeframe;
  $('s-autoScan').checked = settings.autoScan;
  NUM_KEYS.forEach((k) => { $(`s-${k}`).value = settings[k]; });
  $('tf').value = settings.timeframe;
  $('symbol').value = settings.watchlist[0] || 'BTCUSDT';
}
$('saveBtn').addEventListener('click', async () => {
  const settings = {
    watchlist: $('s-watchlist').value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    timeframe: $('s-timeframe').value,
    autoScan: $('s-autoScan').checked,
  };
  NUM_KEYS.forEach((k) => {
    const v = parseFloat($(`s-${k}`).value);
    settings[k] = Number.isFinite(v) ? v : DEFAULT_SETTINGS[k];
  });
  if (!settings.watchlist.length) settings.watchlist = DEFAULT_SETTINGS.watchlist;
  await chrome.storage.local.set({ settings });
  await send({ type: 'settingsChanged' });
  $('saveMsg').textContent = 'সেভ হয়েছে ✓';
  setTimeout(() => { $('saveMsg').textContent = ''; }, 1500);
});
$('scanBtn').addEventListener('click', async () => {
  $('saveMsg').textContent = 'স্ক্যান হচ্ছে...';
  try {
    const { found } = await send({ type: 'scanNow' });
    $('saveMsg').textContent = found ? `${found}টা নতুন সিগন্যাল` : 'নতুন সিগন্যাল নেই';
  } catch (e) {
    $('saveMsg').textContent = e.message;
  }
});

loadSettings();
