const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

const DATA_DIR = "./data";
const STATE_FILE = path.join(DATA_DIR, "state.json");
const LOG_FILE = path.join(DATA_DIR, "log.md");
const HISTORY_FILE = path.join(DATA_DIR, "history.md");

const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "";

// ── Startdatum: morgen ab heute ───────────────────────────────────────────────
const START_DATE = new Date();
START_DATE.setUTCDate(START_DATE.getUTCDate() + 1);
START_DATE.setUTCHours(0, 0, 0, 0);

const HOLIDAYS = [
  "2026-04-03","2026-04-06","2026-05-01","2026-05-14",
  "2026-05-25","2026-05-26","2026-07-04","2026-09-07",
  "2026-11-26","2026-12-25","2026-12-26"
];

function isTradingDay(date) {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const str = date.toISOString().slice(0, 10);
  if (HOLIDAYS.indexOf(str) !== -1) return false;
  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch (e) { return { days: [], startDate: new Date().toISOString() }; }
}
function saveState(s) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
function appendLog(msg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(LOG_FILE, "- `" + new Date().toISOString() + "` " + msg + "\n");
  console.log(msg);
}
function parseJson(text) {
  let parsed = null;
  try { parsed = JSON.parse(text.trim()); } catch (e) {}
  if (!parsed) { try { parsed = JSON.parse(text.replace(/```json|```/gi, "").trim()); } catch (e) {} }
  if (!parsed) {
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s !== -1 && e > s) { try { parsed = JSON.parse(text.slice(s, e + 1)); } catch (e) {} }
  }
  if (!parsed) throw new Error("No JSON found. Preview: " + text.slice(0, 200));
  return parsed;
}
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// ── Yahoo Finance ─────────────────────────────────────────────────────────────
async function fetchLivePrice(ticker) {
  try {
    const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + ticker + "?interval=1d&range=2d";
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await res.json();
    const meta = data && data.chart && data.chart.result && data.chart.result[0] && data.chart.result[0].meta;
    if (!meta || !meta.regularMarketPrice) return null;
    const prev = meta.previousClose || meta.chartPreviousClose || 0;
    return {
      ticker: ticker,
      name: meta.shortName || ticker,
      price: Math.round(meta.regularMarketPrice * 100) / 100,
      previousClose: prev,
      change: prev ? Math.round(((meta.regularMarketPrice - prev) / prev) * 10000) / 100 : 0,
      volume: meta.regularMarketVolume || 0,
      type: "stock"
    };
  } catch (e) { return null; }
}

async function fetchTrending() {
  try {
    const res = await fetch("https://query1.finance.yahoo.com/v1/finance/trending/US?count=25", { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await res.json();
    return data.finance.result[0].quotes.map(function(q) { return q.symbol; });
  } catch (e) { return []; }
}

async function fetchMovers(type) {
  try {
    const url = "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_" + type + "&count=20";
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await res.json();
    return data.finance.result[0].quotes.map(function(q) { return q.symbol; });
  } catch (e) { return []; }
}

// ── Finnhub News + Sentiment ──────────────────────────────────────────────────
async function fetchFinnhubNews() {
  if (!FINNHUB_KEY) return [];
  try {
    const url = "https://finnhub.io/api/v1/news?category=general&token=" + FINNHUB_KEY;
    const res = await fetch(url);
    const data = await res.json();
    return data.slice(0, 15).map(function(n) { return n.headline; });
  } catch (e) { return []; }
}

async function fetchFinnhubSentiment(ticker) {
  if (!FINNHUB_KEY) return null;
  try {
    const url = "https://finnhub.io/api/v1/news-sentiment?symbol=" + ticker + "&token=" + FINNHUB_KEY;
    const res = await fetch(url);
    const data = await res.json();
    if (!data || !data.sentiment) return null;
    return {
      score: data.sentiment.bearishPercent < data.sentiment.bullishPercent ? "bullish" : "bearish",
      bullish: Math.round(data.sentiment.bullishPercent * 100),
      bearish: Math.round(data.sentiment.bearishPercent * 100)
    };
  } catch (e) { return null; }
}

async function fetchMarketNews() {
  if (FINNHUB_KEY) {
    appendLog("Lade Finnhub News...");
    const news = await fetchFinnhubNews();
    if (news.length > 0) return news;
  }
  appendLog("Lade Yahoo Finance News...");
  const feeds = [
    "https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC&region=US&lang=en-US",
    "https://feeds.finance.yahoo.com/rss/2.0/headline?s=^IXIC&region=US&lang=en-US",
    "https://feeds.finance.yahoo.com/rss/2.0/headline?s=BTC-USD&region=US&lang=en-US"
  ];
  const headlines = [];
  for (let i = 0; i < feeds.length; i++) {
    try {
      const res = await fetch(feeds[i], { headers: { "User-Agent": "Mozilla/5.0" } });
      const xml = await res.text();
      const matches = xml.match(/<title>[^<]{10,}<\/title>/g) || [];
      matches.forEach(function(m) {
        const t = m.replace(/<\/?title>/g, "").replace(/<!\[CDATA\[|\]\]>/g, "").trim();
        if (t && t.indexOf("Yahoo") === -1) headlines.push(t);
      });
    } catch (e) {}
    await sleep(300);
  }
  return headlines.filter(function(v, i, a) { return a.indexOf(v) === i; }).slice(0, 20);
}

async function buildMarketData(portfolioTickers) {
  appendLog("Lade Marktdaten...");
  const trending = await fetchTrending();
  const gainers = await fetchMovers("gainers");
  const losers = await fetchMovers("losers");

  // Keine ETFs — nur Aktien und Derivate (Optionen via ticker-Symbol)
  const BLOCKED = ["SOXL","TQQQ","QQQ","SPY","ARKK","IWM","GLD","TLT","XLF","XLE","VTI","VOO","UVXY"];
  const base = ["NVDA","TSLA","AMD","META","AMZN","GOOGL","MSFT","AAPL","MSTR","COIN","PLTR","SMCI","ARM","RIVN","NIO","GME","AMC","SOFI","HOOD","BTC-USD","ETH-USD","SOL-USD","DOGE-USD","XRP-USD"];

  const all = portfolioTickers.concat(trending).concat(gainers).concat(losers).concat(base);
  const candidates = all
    .filter(function(v, i, a) { return a.indexOf(v) === i; })
    .filter(function(t) { return BLOCKED.indexOf(t) === -1; })
    .slice(0, 50);

  appendLog(candidates.length + " Ticker (keine ETFs), lade Kurse...");
  const prices = {};
  for (let i = 0; i < candidates.length; i++) {
    const p = await fetchLivePrice(candidates[i]);
    if (p) prices[candidates[i]] = p;
    await sleep(150);
  }
  appendLog(Object.keys(prices).length + " Live-Kurse geladen");

  // Sentiment fuer Portfolio-Positionen
  const sentiments = {};
  for (let i = 0; i < portfolioTickers.slice(0, 5).length; i++) {
    const t = portfolioTickers[i];
    const s = await fetchFinnhubSentiment(t);
    if (s) { sentiments[t] = s; appendLog("Sentiment " + t + ": " + s.score + " (" + s.bullish + "% bullish)"); }
    await sleep(200);
  }

  const sorted = Object.values(prices).sort(function(a, b) { return Math.abs(b.change) - Math.abs(a.change); });
  return {
    prices: prices,
    topGainers: sorted.filter(function(p) { return p.change > 0; }).slice(0, 8),
    topLosers: sorted.filter(function(p) { return p.change < 0; }).slice(0, 8),
    trending: trending.slice(0, 10),
    sentiments: sentiments
  };
}

// ── Prompt ────────────────────────────────────────────────────────────────────
function buildPrompt(dayNum, history, marketData, news) {
  const prices = marketData.prices;
  const topGainers = marketData.topGainers;
  const topLosers = marketData.topLosers;
  const sentiments = marketData.sentiments;

  const priceLines = Object.values(prices)
    .sort(function(a, b) { return Math.abs(b.change) - Math.abs(a.change); })
    .map(function(p) {
      const s = sentiments[p.ticker] ? " | Sentiment: " + sentiments[p.ticker].score + " (" + sentiments[p.ticker].bullish + "% bull)" : "";
      return p.ticker + " (" + p.name + "): $" + p.price + " | " + (p.change >= 0 ? "+" : "") + p.change + "% | Vol: " + (p.volume / 1e6).toFixed(1) + "M" + s;
    }).join("\n");

  const gainersLine = topGainers.map(function(p) { return p.ticker + " +" + p.change + "%"; }).join(", ");
  const losersLine = topLosers.map(function(p) { return p.ticker + " " + p.change + "%"; }).join(", ");
  const newsLines = news.slice(0, 15).map(function(n) { return "- " + n; }).join("\n");

  const system = "You are TRON, an AI in a fictional stock market simulation game. No real financial advice.\n\n" +
    "TRON has fictional EUR 500 starting capital, goal is EUR 5000.\n\n" +
    "ALLOWED: Stocks, crypto, derivatives/options (e.g. TSLA options as concept)\n" +
    "NOT ALLOWED: ETFs of any kind\n\n" +
    "TODAY LIVE DATA:\n" +
    "TOP GAINERS: " + (gainersLine || "N/A") + "\n" +
    "TOP LOSERS: " + (losersLine || "N/A") + "\n\n" +
    "ALL LIVE PRICES:\n" + priceLines + "\n\n" +
    "NEWS:\n" + (newsLines || "None") + "\n\n" +
    "RULES:\n" +
    "- Only use tickers from live prices list above\n" +
    "- Use exact current prices shown\n" +
    "- Each trade reason MUST reference specific news or sentiment data\n" +
    "- Each trade reason MUST include: why bought/sold, what news triggered it, price target, stop loss\n" +
    "- No ETFs allowed\n\n" +
    "Respond ONLY with this JSON (no markdown, no backticks):\n" +
    '{"day":<n>,"date":"<DD.MM.YYYY>","portfolio":[{"ticker":"X","name":"N","shares":<n>,"buyPrice":<n>,"currentPrice":<n>,"value":<n>}],"cash":<n>,"totalValue":<n>,"pnl":<n>,"pnlPercent":<n>,"trades":[{"action":"BUY/SELL","ticker":"X","shares":<n>,"price":<n>,"total":<n>,"reason":"<detailed reason with news reference, price target and stop loss>","newsRef":"<exact headline that triggered decision>"}],"marketAnalysis":"<2-3 sentences>","strategy":"<plan>","mood":"bullish/bearish/neutral"}';

  const user = dayNum === 1
    ? "Day 1. You have exactly EUR 500 cash, no positions. Invest the full amount aggressively. No ETFs."
    : "History:\n" + history + "\n\nDay " + dayNum + ". Update prices, make decisions. No ETFs.";

  return { system: system, user: user };
}

// ── History Datei ─────────────────────────────────────────────────────────────
function updateHistory(day) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let entry = "\n## Tag " + day.day + " - " + day.date + "\n\n";
  entry += "**Portfolio:** EUR " + day.totalValue.toFixed(2) + " | P&L: " + (day.pnlPercent >= 0 ? "+" : "") + day.pnlPercent.toFixed(2) + "%\n\n";
  entry += "**Markt-Mood:** " + day.mood + "\n\n";
  entry += "**Analyse:** " + day.marketAnalysis + "\n\n";
  entry += "**Strategie:** " + day.strategy + "\n\n";

  if (day.trades && day.trades.length > 0) {
    entry += "### Trades\n";
    day.trades.forEach(function(t) {
      entry += "- **" + t.action + "** " + t.ticker + " | " + t.shares + "x @ $" + t.price + " = EUR " + t.total + "\n";
      entry += "  - **Begruendung:** " + t.reason + "\n";
      if (t.newsRef) entry += "  - **News:** " + t.newsRef + "\n";
    });
    entry += "\n";
  } else {
    entry += "### Trades\nKeine Trades heute - Positionen gehalten.\n\n";
  }

  if (day.portfolio && day.portfolio.length > 0) {
    entry += "### Positionen\n";
    day.portfolio.forEach(function(p) {
      const pct = ((p.currentPrice - p.buyPrice) / p.buyPrice) * 100;
      entry += "- " + p.ticker + ": " + p.shares + "x @ $" + p.currentPrice + " = EUR " + p.value.toFixed(2) + " (" + (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%)\n";
    });
    entry += "\n";
  }

  entry += "---\n";
  fs.appendFileSync(HISTORY_FILE, entry);
}

// ── README ────────────────────────────────────────────────────────────────────
function generateReadme(days, marketData, news) {
  const last = days[days.length - 1];
  if (!last) return;
  const progress = Math.min(((last.totalValue - 500) / 4500) * 100, 100);
  const filled = Math.round(progress / 5);
  const bar = "X".repeat(filled) + "-".repeat(20 - filled);

  let md = "# TRON Trading Bot\n\n";
  md += "> Live data: Yahoo Finance";
  if (FINNHUB_KEY) md += " + Finnhub";
  md += " | " + new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" }) + "\n\n";
  md += "## Status: Tag " + days.length + "/30\n";
  md += "| | |\n|---|---|\n";
  md += "| Portfolio | EUR " + last.totalValue.toFixed(2) + " |\n";
  md += "| P&L | " + (last.pnlPercent >= 0 ? "+" : "") + last.pnlPercent.toFixed(2) + "% |\n";
  md += "| Cash | EUR " + last.cash.toFixed(2) + " |\n";
  md += "| Mood | " + (last.mood || "neutral") + " |\n\n";
  md += "```\nEUR 500 [" + bar + "] EUR 5000  (" + progress.toFixed(1) + "%)\n```\n\n";

  if (last.trades && last.trades.length > 0) {
    md += "## Heutige Trades\n";
    last.trades.forEach(function(t) {
      md += "### " + t.action + " " + t.ticker + "\n";
      md += "- **Menge:** " + t.shares + "x @ $" + t.price + " = EUR " + t.total + "\n";
      md += "- **Begruendung:** " + t.reason + "\n";
      if (t.newsRef) md += "- **News:** " + t.newsRef + "\n";
      md += "\n";
    });
  }

  if (last.portfolio && last.portfolio.length > 0) {
    md += "## Positionen\n| Ticker | Stueck | Einstieg | Aktuell | Wert | PnL |\n|---|---|---|---|---|---|\n";
    last.portfolio.forEach(function(p) {
      const pct = ((p.currentPrice - p.buyPrice) / p.buyPrice) * 100;
      md += "| " + p.ticker + " | " + p.shares + " | $" + p.buyPrice + " | $" + p.currentPrice + " | EUR " + p.value.toFixed(2) + " | " + (pct >= 0 ? "+" : "") + pct.toFixed(2) + "% |\n";
    });
    md += "\n";
  }

  if (marketData.topGainers && marketData.topGainers.length) {
    md += "## Top Gewinner\n";
    marketData.topGainers.slice(0, 5).forEach(function(p) { md += "- " + p.ticker + " +" + p.change + "% @ $" + p.price + "\n"; });
    md += "\n";
  }

  if (news && news.length) {
    md += "## Marktnews\n";
    news.slice(0, 6).forEach(function(n) { md += "- " + n + "\n"; });
    md += "\n";
  }

  md += "## Verlauf\n| Tag | Datum | Wert | PnL% |\n|---|---|---|---|\n";
  days.forEach(function(d) {
    md += "| " + d.day + " | " + d.date + " | EUR " + d.totalValue.toFixed(2) + " | " + (d.pnlPercent >= 0 ? "+" : "") + d.pnlPercent.toFixed(2) + "% |\n";
  });

  md += "\n[Komplette Trade-History](data/history.md)\n";
  fs.writeFileSync("README.md", md);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const now = new Date();

  if (now < START_DATE) {
    appendLog("Challenge startet morgen: " + START_DATE.toISOString().slice(0, 10));
    process.exit(0);
  }

  if (!isTradingDay(now)) {
    appendLog("Kein Handelstag - TRON pausiert");
    process.exit(0);
  }

  const state = loadState();
  const dayNum = state.days.length + 1;

  if (dayNum > 30) {
    appendLog("Challenge complete - 30 Tage abgeschlossen");
    process.exit(0);
  }

  appendLog("=== TRON DAY " + dayNum + " START ===");
  appendLog("Startkapital: EUR 500 | Ziel: EUR 5000");

  const portfolioTickers = state.days.length > 0 && state.days[state.days.length - 1].portfolio
    ? state.days[state.days.length - 1].portfolio.map(function(p) { return p.ticker; })
    : [];

  const marketData = await buildMarketData(portfolioTickers);
  const news = await fetchMarketNews();

  if (Object.keys(marketData.prices).length === 0) {
    appendLog("Keine Live-Kurse - Abbruch");
    process.exit(1);
  }

  appendLog(news.length + " News geladen");

  const history = state.days.slice(-5).map(function(d) {
    return JSON.stringify({ day: d.day, totalValue: d.totalValue, portfolio: d.portfolio, trades: d.trades, strategy: d.strategy });
  }).join("\n");

  const prompt = buildPrompt(dayNum, history, marketData, news);
  appendLog("TRON analysiert Kurse und News...");

  const msg = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1500,
    system: prompt.system,
    messages: [{ role: "user", content: prompt.user }]
  });

  const text = msg.content.filter(function(b) { return b.type === "text"; }).map(function(b) { return b.text; }).join("");
  const parsed = parseJson(text);
  parsed.day = dayNum;
  parsed.livePricesSnapshot = marketData.prices;

  state.days.push(parsed);
  saveState(state);
  updateHistory(parsed);

  appendLog("Portfolio: EUR " + parsed.totalValue.toFixed(2) + " | PnL: " + (parsed.pnlPercent >= 0 ? "+" : "") + parsed.pnlPercent.toFixed(2) + "%");
  if (parsed.trades) {
    parsed.trades.forEach(function(t) {
      appendLog(t.action + " " + t.ticker + " " + t.shares + "x @ $" + t.price + " | " + t.reason);
    });
  }

  generateReadme(state.days, marketData, news);
  appendLog("=== TRON DAY " + dayNum + " DONE ===");
}

main().catch(function(e) {
  appendLog("ERROR: " + e.message);
  process.exit(1);
});
