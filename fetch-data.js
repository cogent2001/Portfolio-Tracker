// Daily data fetch script for the Portfolio Tracker dashboard.
// Runs inside GitHub Actions (Node.js has full network access there — this
// cannot run inside the Claude sandbox, which has none).
//
// Data source: EODHD (https://eodhd.com) — free tier, 20 requests/day,
// confirmed London Stock Exchange coverage via the ".LSE" suffix (EODHD's
// own docs use "BP.LSE" as their example). Requires a free API key stored
// as a GitHub repository secret named EODHD_API_KEY (Settings -> Secrets
// and variables -> Actions). Free tier returns the past year of history —
// this script merges each day's new row into deep history already saved
// in data.json, so history keeps growing beyond that one-year window.
//
// What it does each run:
//   1. Calls EODHD's /api/eod/{SYMBOL} endpoint for each ticker.
//   2. Merges the new rows into the existing history already committed in
//      data.json (so we keep deep history beyond whatever the API returns
//      in one call, and never lose the manually-seeded past).
//   3. Recomputes the same trend/volume/technical-analysis numbers the
//      dashboard displays.
//   4. Writes data.json, which index.html fetches at page-load time.
//
// Requires Node 18+ (GitHub's runner ships a recent Node), which has a
// built-in global fetch — no extra dependencies to install.

const API_KEY = process.env.EODHD_API_KEY;
if (!API_KEY) {
  console.error("Missing EODHD_API_KEY environment variable / repository secret.");
  process.exit(1);
}

const TICKERS = [
  { symbol: "RR",   eod: "RR.LSE",   name: "Rolls-Royce Hldgs",  kind: "holding", shares: 13516, avgCostPence: 1560.3198, bookCost: 210892.82 },
  { symbol: "MTRO", eod: "MTRO.LSE", name: "Metro Bank Holding", kind: "holding", shares: 47264, avgCostPence: 153.001,  bookCost: 72314.40 },
  { symbol: "TRAC", eod: "TRAC.LSE", name: "T42 IoT Tracking",   kind: "holding", shares: 546765, avgCostPence: 4.3215, bookCost: 23628.45 },
  { symbol: "JET2", eod: "JET2.LSE", name: "Jet2 plc",           kind: "watchlist" }
];

// Holdings with no chart tracking (per user request) — P&L only, kept static.
const STATIC_HOLDINGS = [
  { symbol: "SOU", name: "Sound Energy",    shares: 141439, avgCostPence: 27.6219, bookCost: 39068.12, noChart: true },
  { symbol: "TRP", name: "Tower Resources", shares: 545,    avgCostPence: 419.4532, bookCost: 2286.02, noChart: true }
];

async function fetchEodhd(eodSymbol) {
  const url = `https://eodhd.com/api/eod/${encodeURIComponent(eodSymbol)}?api_token=${API_KEY}&fmt=json&period=d`;
  const res = await fetch(url);
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`EODHD HTTP ${res.status} for ${eodSymbol}: ${bodyText.slice(0, 300)}`);
  }
  const json = await res.json();
  if (!Array.isArray(json)) {
    throw new Error(`EODHD returned no array for ${eodSymbol}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  // Note: EODHD returns LSE prices in GBP pence-equivalent already scaled as
  // GBX (pence) for LSE tickers in most cases, but to be safe we treat the
  // raw numeric value as pounds and convert to pence like other sources,
  // then sanity-check: if the resulting price looks two orders of magnitude
  // off vs. typical LSE penny-stock ranges it is logged, not silently used.
  return json
    .map(v => ({
      date: v.date,
      open: +(parseFloat(v.open) * 100).toFixed(4),
      high: +(parseFloat(v.high) * 100).toFixed(4),
      low: +(parseFloat(v.low) * 100).toFixed(4),
      close: +(parseFloat(v.close) * 100).toFixed(4),
      volume: parseInt(v.volume, 10) || 0
    }))
    .filter(r => r.date && !isNaN(r.close) && r.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function mergeSeries(existing, fresh) {
  const byDate = new Map();
  (existing || []).forEach(r => byDate.set(r.date, r));
  fresh.forEach(r => byDate.set(r.date, r)); // fresh rows win on overlap (corrects any earlier bad data)
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ---- Technical analysis (mirrors the dashboard's existing logic) ----
function sma(values, period) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    out.push(sum / period);
  }
  return out;
}

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev;
  values.forEach((v, i) => {
    if (i === 0) { prev = v; out.push(v); return; }
    prev = v * k + prev * (1 - k);
    out.push(prev);
  });
  return out;
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period && i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  if (period < closes.length) out[period] = 100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}

function trendFromStructure(series, lookback) {
  const slice = series.slice(-lookback);
  if (slice.length < 5) return { direction: "Insufficient data", pctChange: 0, maSignal: "n/a", periodHigh: 0, periodLow: 0 };
  const highs = [], lows = [];
  for (let i = 2; i < slice.length - 2; i++) {
    const h = slice[i].high, l = slice[i].low;
    if (h >= slice[i - 1].high && h >= slice[i - 2].high && h >= slice[i + 1].high && h >= slice[i + 2].high) highs.push(h);
    if (l <= slice[i - 1].low && l <= slice[i - 2].low && l <= slice[i + 1].low && l <= slice[i + 2].low) lows.push(l);
  }
  const pctChange = ((slice[slice.length - 1].close - slice[0].close) / slice[0].close) * 100;
  let structure = "Sideways / consolidating";
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs[highs.length - 1] > highs[highs.length - 2];
    const hl = lows[lows.length - 1] > lows[lows.length - 2];
    const lh = highs[highs.length - 1] < highs[highs.length - 2];
    const ll = lows[lows.length - 1] < lows[lows.length - 2];
    if (hh && hl) structure = "Uptrend (higher highs, higher lows)";
    else if (lh && ll) structure = "Downtrend (lower highs, lower lows)";
  }
  const closes = slice.map(d => d.close);
  const smaShort = sma(closes, Math.min(20, Math.max(2, closes.length - 1)));
  const smaLong = sma(closes, Math.min(50, Math.max(3, closes.length - 1)));
  const lastShort = smaShort[smaShort.length - 1], lastLong = smaLong[smaLong.length - 1];
  const maSignal = lastShort && lastLong
    ? (lastShort > lastLong ? "Short-term MA above long-term MA (bullish bias)" : "Short-term MA below long-term MA (bearish bias)")
    : "n/a";
  return {
    direction: structure,
    pctChange: +pctChange.toFixed(2),
    maSignal,
    periodHigh: +Math.max(...slice.map(s => s.high)).toFixed(4),
    periodLow: +Math.min(...slice.map(s => s.low)).toFixed(4)
  };
}

function volumeAnalysis(series, lookback) {
  const slice = series.slice(-lookback);
  const avgVol = slice.reduce((a, b) => a + b.volume, 0) / slice.length;
  const priceUp = slice[slice.length - 1].close > slice[0].close;
  const recentN = Math.min(5, slice.length);
  const recentAvg = slice.slice(-recentN).reduce((a, b) => a + b.volume, 0) / recentN;
  const volTrend = recentAvg > avgVol * 1.1 ? "Rising" : recentAvg < avgVol * 0.9 ? "Falling" : "Stable";
  let confirmation = "Neutral";
  if (priceUp && volTrend === "Rising") confirmation = "Volume confirms uptrend";
  else if (priceUp && volTrend === "Falling") confirmation = "Uptrend on weakening volume (caution)";
  else if (!priceUp && volTrend === "Rising") confirmation = "Volume confirms downtrend";
  else if (!priceUp && volTrend === "Falling") confirmation = "Downtrend on weakening volume (possible exhaustion)";
  return { avgVolume: Math.round(avgVol), recentAvgVolume: Math.round(recentAvg), volumeTrend: volTrend, confirmation };
}

function supportResistance(series, lookback = 252) {
  const slice = series.slice(-lookback);
  const highs = [], lows = [];
  for (let i = 2; i < slice.length - 2; i++) {
    const h = slice[i].high, l = slice[i].low;
    if (h >= slice[i - 1].high && h >= slice[i - 2].high && h >= slice[i + 1].high && h >= slice[i + 2].high) highs.push(h);
    if (l <= slice[i - 1].low && l <= slice[i - 2].low && l <= slice[i + 1].low && l <= slice[i + 2].low) lows.push(l);
  }
  highs.sort((a, b) => b - a);
  lows.sort((a, b) => a - b);
  return {
    resistance: [...new Set(highs.map(v => +v.toFixed(0)))].slice(0, 4),
    support: [...new Set(lows.map(v => +v.toFixed(0)))].slice(0, 4)
  };
}

function volatility(series, lookback = 22) {
  const slice = series.slice(-lookback);
  const ranges = slice.map(d => ((d.high - d.low) / d.close) * 100);
  const avgRangePct = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const closes = slice.map(d => d.close);
  const dailyReturns = [];
  for (let i = 1; i < closes.length; i++) dailyReturns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / dailyReturns.length;
  return { avgDailyRangePct: +avgRangePct.toFixed(2), dailyVolPct: +Math.sqrt(variance * 100 * 100).toFixed(2) };
}

function fullAnalysisFor(series) {
  const closes = series.map(d => d.close);
  const ema12 = ema(closes, 12), ema26 = ema(closes, 26);
  const macdLine = closes.map((_, i) => ema12[i] - ema26[i]);
  const signalLine = ema(macdLine, 9);
  const macdHist = macdLine.map((v, i) => v - signalLine[i]);
  const sma50 = sma(closes, 50), sma200 = sma(closes, 200);
  const rsiSeries = rsi(closes, 14);
  const last = series[series.length - 1];
  const lastIdx = series.length - 1;
  const sr = supportResistance(series);
  const avgVol20 = series.slice(-20).reduce((a, b) => a + b.volume, 0) / Math.min(20, series.length);
  const avgVol60 = series.slice(-60).reduce((a, b) => a + b.volume, 0) / Math.min(60, series.length);
  function pctChangeOver(n) {
    const start = series[Math.max(0, series.length - 1 - n)].close;
    return ((last.close - start) / start) * 100;
  }
  return {
    lastClose: last.close,
    lastDate: last.date,
    changeVsPrev: lastIdx > 0 ? +(((last.close - series[lastIdx - 1].close) / series[lastIdx - 1].close) * 100).toFixed(2) : 0,
    trend: {
      shortTerm10d: +pctChangeOver(10).toFixed(2),
      mediumTerm22d: +pctChangeOver(22).toFixed(2),
      longTerm252d: +pctChangeOver(Math.min(252, series.length - 1)).toFixed(2),
      fiveYear: series.length > 1250 ? +pctChangeOver(Math.min(1250, series.length - 1)).toFixed(2) : null
    },
    levels: {
      fiftyTwoWeekHigh: +Math.max(...series.slice(-252).map(d => d.high)).toFixed(2),
      fiftyTwoWeekLow: +Math.min(...series.slice(-252).map(d => d.low)).toFixed(2),
      yesterdayHigh: last.high,
      yesterdayLow: last.low,
      prevClose: lastIdx > 0 ? series[lastIdx - 1].close : last.close,
      support: sr.support,
      resistance: sr.resistance
    },
    indicators: {
      macd: +macdLine[lastIdx].toFixed(2),
      macdSignal: +signalLine[lastIdx].toFixed(2),
      macdHist: +macdHist[lastIdx].toFixed(2),
      rsi14: rsiSeries[lastIdx] !== null ? +rsiSeries[lastIdx].toFixed(1) : null,
      sma50: sma50[lastIdx] !== null ? +sma50[lastIdx].toFixed(2) : null,
      sma200: sma200[lastIdx] !== null ? +sma200[lastIdx].toFixed(2) : null,
      sma50Direction: sma50[lastIdx] && sma50[lastIdx - 5] ? (sma50[lastIdx] > sma50[lastIdx - 5] ? "Rising" : "Falling") : null,
      sma200Direction: sma200[lastIdx] && sma200[lastIdx - 5] ? (sma200[lastIdx] > sma200[lastIdx - 5] ? "Rising" : "Falling") : null
    },
    volume: {
      lastVolume: last.volume,
      avgVolume20d: Math.round(avgVol20),
      avgVolume60d: Math.round(avgVol60),
      aboveAverage: last.volume > avgVol20
    }
  };
}

async function main() {
  const fs = await import("node:fs/promises");

  // Load whatever data.json already exists in the repo, so we merge into
  // deep history rather than starting fresh with only 300 days each run.
  let existingDataset = {};
  try {
    const prev = JSON.parse(await fs.readFile("data.json", "utf8"));
    existingDataset = prev.dataset || {};
  } catch {
    console.log("No existing data.json found — starting fresh.");
  }

  const dataset = {};
  const analysis = {};
  const fullAnalysis = {};

  for (const t of TICKERS) {
    console.log(`Fetching ${t.symbol} (${t.td})...`);
    const fresh = await fetchTwelveData(t.td);
    const merged = mergeSeries(existingDataset[t.symbol], fresh);
    dataset[t.symbol] = merged;
    analysis[t.symbol] = {
      day: { trend: trendFromStructure(merged, 10), volume: volumeAnalysis(merged, 10) },
      month: { trend: trendFromStructure(merged, 22), volume: volumeAnalysis(merged, 22) },
      year: { trend: trendFromStructure(merged, Math.min(252, merged.length)), volume: volumeAnalysis(merged, Math.min(252, merged.length)) }
    };
    if (t.kind === "watchlist") {
      analysis[t.symbol].supportResistance = supportResistance(merged);
      analysis[t.symbol].volatility = volatility(merged);
      fullAnalysis[t.symbol] = fullAnalysisFor(merged);
    }
  }

  // Carry over any tickers from the old data.json not refetched this run
  // (defensive — keeps history if a ticker temporarily errors elsewhere).
  for (const sym of Object.keys(existingDataset)) {
    if (!dataset[sym]) dataset[sym] = existingDataset[sym];
  }

  const holdingsInput = TICKERS.filter(t => t.kind === "holding").map(t => ({
    symbol: t.symbol, name: t.name, shares: t.shares, avgCostPence: t.avgCostPence, bookCost: t.bookCost
  })).concat(STATIC_HOLDINGS);

  const watchlistInput = TICKERS.filter(t => t.kind === "watchlist").map(t => ({ symbol: t.symbol, name: t.name }));

  for (const s of STATIC_HOLDINGS) {
    if (!dataset[s.symbol]) {
      const flatPrice = (s.bookCost / s.shares) * 100;
      dataset[s.symbol] = [{ date: new Date().toISOString().slice(0, 10), open: flatPrice, high: flatPrice, low: flatPrice, close: flatPrice, volume: 0 }];
    }
  }

  const bundle = {
    generatedAt: new Date().toISOString(),
    holdings: holdingsInput,
    watchlist: watchlistInput,
    dataset,
    analysis,
    fullAnalysis
  };

  await fs.writeFile("data.json", JSON.stringify(bundle));
  console.log("Wrote data.json —", Object.keys(dataset).map(k => `${k}:${dataset[k].length}`).join(", "));
}

main().catch(err => {
  console.error("Fetch job failed:", err);
  process.exit(1);
});
