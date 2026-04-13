const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

const DATA_DIR = "./data";
const STATE_FILE = path.join(DATA_DIR, "state.json");
const LOG_FILE = path.join(DATA_DIR, "log.md");
const HISTORY_FILE = path.join(DATA_DIR, "history.md");
const NEWS_FILE = path.join(DATA_DIR, "news.md");

const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "";

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
  if (HOLIDAYS.indexOf(date.toISOString().slice(0, 10)) !== -1) return false;
  return true;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch (e) { return { days: [], cash: 500 }; }
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
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function parseJson(text) {
  let p = null;
  try { p = JSON.parse(text.trim()); } catch (e) {}
  if (!p) { try { p = JSON.parse(text.replace(/```json|```/gi, "").trim()); } catch (e) {} }
  if (!p) {
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s !== -1 && e > s) { try { p = JSON.parse(text.slice(s, e + 1)); } catch (e) {} }
  }
  if (!p) throw new Error("No JSON. Preview: " + text.slice(0, 300));
  return p;
}

// ── LIVE KURSE ────────────────────────────────────────────────────────────────
async function fetchYahooPrice(ticker) {
  try {
    const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + ticker + "?interval=1d&range=5d";
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await res.json();
    const meta = data && data.chart && data.chart.result && data.chart.result[0] && data.chart.result[0].meta;
    if (!meta || !meta.regularMarketPrice) return null;
    const prev = meta.previousClose || meta.chartPreviousClose || 0;
    const price = Math.round(meta.regularMarketPrice * 100) / 100;
    return {
      ticker: ticker,
      name: meta.shortName || ticker,
      price: price,
      previousClose: Math.round(prev * 100) / 100,
      changePercent: prev ? Math.round(((price - prev) / prev) * 10000) / 100 : 0,
      changeDollar: Math.round((price - prev) * 100) / 100,
      volume: meta.regularMarketVolume || 0,
      high52w: meta.fiftyTwoWeekHigh || 0,
      low52w: meta.fiftyTwoWeekLow || 0,
      currency: meta.currency || "USD",
      exchange: meta.exchangeName || "",
      fetchedAt: new Date().toISOString()
    };
  } catch (e) { return null; }
}

async function fetchFinnhubPrice(ticker) {
  if (!FINNHUB_KEY) return null;
  try {
    const url = "https://finnhub.io/api/v1/quote?symbol=" + ticker + "&token=" + FINNHUB_KEY;
    const res = await fetch(url);
    const data = await res.json();
    if (!data || !data.c || data.c === 0) return null;
    return {
      price: Math.round(data.c * 100) / 100,
      previousClose: Math.round(data.pc * 100) / 100,
      changePercent: data.pc ? Math.round(((data.c - data.pc) / data.pc) * 10000) / 100 : 0,
      high: data.h,
      low: data.l,
      open: data.o
    };
  } catch (e) { return null; }
}

async function fetchLivePrice(ticker) {
  const yahoo = await fetchYahooPrice(ticker);
  const finnhub = await fetchFinnhubPrice(ticker);
  if (!yahoo && !finnhub) return null;
  if (!yahoo) return finnhub;
  // Merge: Yahoo als Basis, Finnhub ergaenzt High/Low/Open
  if (finnhub) {
    yahoo.high = finnhub.high || 0;
    yahoo.low = finnhub.low || 0;
    yahoo.open = finnhub.open || 0;
  }
  return yahoo;
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

// ── NEWS ──────────────────────────────────────────────────────────────────────
async function fetchFinnhubNews() {
  if (!FINNHUB_KEY) return [];
  try {
    const url = "https://finnhub.io/api/v1/news?category=general&token=" + FINNHUB_KEY;
    const res = await fetch(url);
    const data = await res.json();
    return data.slice(0, 20).map(function(n) {
      return { headline: n.headline, summary: n.summary || "", source: n.source || "", url: n.url || "" };
    });
  } catch (e) { return []; }
}

async function fetchFinnhubTickerNews(ticker) {
  if (!FINNHUB_KEY) return [];
  try {
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const url = "https://finnhub.io/api/v1/company-news?symbol=" + ticker + "&from=" + weekAgo + "&to=" + today + "&token=" + FINNHUB_KEY;
    const res = await fetch(url);
    const data = await res.json();
    return data.slice(0, 5).map(function(n) { return n.headline; });
  } catch (e) { return []; }
}

async function fetchYahooNews() {
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
        if (t && t.indexOf("Yahoo") === -1) headlines.push({ headline: t, source: "Yahoo Finance", summary: "", url: "" });
      });
    } catch (e) {}
    await sleep(300);
  }
  return headlines.filter(function(v, i, a) { return a.map(function(x) { return x.headline; }).indexOf(v.headline) === i; }).slice(0, 20);
}

async function fetchAllNews(portfolioTickers) {
  appendLog("Lade News...");
  let marketNews = [];
  if (FINNHUB_KEY) {
    marketNews = await fetchFinnhubNews();
    appendLog("Finnhub: " + marketNews.length + " News geladen");
  }
  if (marketNews.length === 0) {
    marketNews = await fetchYahooNews();
    appendLog("Yahoo News: " + marketNews.length + " Headlines geladen");
  }

  // Ticker-spezifische News fuer aktuelle Positionen
  const tickerNews = {};
  for (let i = 0; i < portfolioTickers.slice(0, 6).length; i++) {
    const t = portfolioTickers[i];
    const news = await fetchFinnhubTickerNews(t);
    if (news.length > 0) {
      tickerNews[t] = news;
      appendLog("News fuer " + t + ": " + news.length + " Artikel");
    }
    await sleep(200);
  }
  return { marketNews: marketNews, tickerNews: tickerNews };
}

// ── MARKTDATEN ────────────────────────────────────────────────────────────────
async function buildMarketData(portfolioTickers) {
  appendLog("Lade Marktdaten...");
  const trending = await fetchTrending();
  const gainers = await fetchMovers("gainers");
  const losers = await fetchMovers("losers");

  const BLOCKED_ETFS = ["SOXL","TQQQ","QQQ","SPY","ARKK","IWM","GLD","TLT","XLF","XLE","VTI","VOO","UVXY","VIXY","SQQQ","SH","PSQ","DIA","XLK","XLV"];
  const base = ["NVDA","TSLA","AMD","META","AMZN","GOOGL","MSFT","AAPL","MSTR","COIN","PLTR","SMCI","ARM","RIVN","NIO","GME","SOFI","HOOD","BTC-USD","ETH-USD","SOL-USD","DOGE-USD","XRP-USD","BNB-USD"];

  const all = portfolioTickers.concat(trending).concat(gainers).concat(losers).concat(base);
  const candidates = all
    .filter(function(v, i, a) { return a.indexOf(v) === i; })
    .filter(function(t) { return BLOCKED_ETFS.indexOf(t) === -1; })
    .slice(0, 50);

  appendLog(candidates.length + " Ticker (ETFs geblockt), lade Live-Kurse...");
  const prices = {};
  for (let i = 0; i < candidates.length; i++) {
    const p = await fetchLivePrice(candidates[i]);
    if (p) {
      prices[candidates[i]] = p;
      appendLog("Live: " + candidates[i] + " = $" + p.price + " (" + (p.changePercent >= 0 ? "+" : "") + p.changePercent + "%)");
    }
    await sleep(150);
  }
  appendLog(Object.keys(prices).length + " echte Live-Kurse geladen");

  const sorted = Object.values(prices).sort(function(a, b) { return Math.abs(b.changePercent) - Math.abs(a.changePercent); });
  return {
    prices: prices,
    topGainers: sorted.filter(function(p) { return p.changePercent > 0; }).slice(0, 8),
    topLosers: sorted.filter(function(p) { return p.changePercent < 0; }).slice(0, 8),
    trending: trending.slice(0, 10)
  };
}

// ── NEWS ANALYSE (Claude bewertet die News) ───────────────────────────────────
async function analyzeNews(newsData, marketData, dayNum) {
  appendLog("TRON analysiert News...");

  const headlines = newsData.marketNews.map(function(n) { return n.headline + (n.summary ? " - " + n.summary.slice(0, 100) : ""); }).join("\n");
  const tickerNewsText = Object.keys(newsData.tickerNews).map(function(t) {
    return t + ":\n" + newsData.tickerNews[t].map(function(h) { return "  - " + h; }).join("\n");
  }).join("\n");

  const topMovers = marketData.topGainers.concat(marketData.topLosers)
    .map(function(p) { return p.ticker + " " + (p.changePercent >= 0 ? "+" : "") + p.changePercent + "%"; }).join(", ");

  const prompt = "You are TRON, an aggressive fictional trading AI. Analyze today's real market news and give your trading thoughts.\n\n" +
    "TODAY'S HEADLINES:\n" + headlines + "\n\n" +
    "TICKER NEWS:\n" + (tickerNewsText || "None available") + "\n\n" +
    "TOP MOVERS TODAY: " + topMovers + "\n\n" +
    "Respond ONLY with this JSON (no markdown, no backticks):\n" +
    '{"summary":"<3-4 sentence summary of the most important news today>","keyEvents":[{"headline":"<exact headline>","impact":"bullish/bearish/neutral","affectedTickers":["X","Y"],"explanation":"<why this matters>"}],"tronThoughts":"<TRONs personal analysis: what does this mean for the market, which opportunities does TRON see, what risks, how would TRON react to this news - be specific and opinionated, min 5 sentences>","tradingImplications":[{"ticker":"X","action":"consider_buy/consider_sell/watch/avoid","reason":"<specific news-based reason>","urgency":"high/medium/low"}]}';

  const msg = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }]
  });

  const text = msg.content.filter(function(b) { return b.type === "text"; }).map(function(b) { return b.text; }).join("");
  try {
    return parseJson(text);
  } catch (e) {
    appendLog("News analysis parse error: " + e.message);
    return {
      summary: "News analysis not available today.",
      keyEvents: [],
      tronThoughts: "Unable to analyze news today.",
      tradingImplications: []
    };
  }
}

// ── TRADING ENTSCHEIDUNG ──────────────────────────────────────────────────────
function buildTradingPrompt(dayNum, history, marketData, newsAnalysis) {
  const prices = marketData.prices;
  const priceLines = Object.values(prices)
    .sort(function(a, b) { return Math.abs(b.changePercent) - Math.abs(a.changePercent); })
    .map(function(p) {
      return p.ticker + " (" + p.name + "): $" + p.price +
        " | " + (p.changePercent >= 0 ? "+" : "") + p.changePercent + "%" +
        " | Vol: " + (p.volume / 1e6).toFixed(1) + "M" +
        (p.high ? " | H: $" + p.high + " L: $" + p.low : "");
    }).join("\n");

  const implications = newsAnalysis.tradingImplications
    ? newsAnalysis.tradingImplications.map(function(t) { return t.ticker + " -> " + t.action + " (" + t.urgency + "): " + t.reason; }).join("\n")
    : "None";

  const system = "You are TRON, a fictional aggressive trading AI with EUR 500 start capital, goal EUR 5000.\n\n" +
    "STRICT RULES:\n" +
    "- Only trade tickers listed in LIVE PRICES below\n" +
    "- Use EXACT prices shown - these are real live prices\n" +
    "- NO ETFs allowed (no QQQ, SPY, SOXL, TQQQ etc)\n" +
    "- Stocks, crypto, derivatives only\n" +
    "- Each trade MUST reference specific news or price movement\n" +
    "- Include price target and stop loss for every trade\n" +
    "- Do NOT invent prices - use only what is listed below\n\n" +
    "LIVE PRICES (real, from Yahoo Finance):\n" + priceLines + "\n\n" +
    "NEWS TRADING SIGNALS:\n" + implications + "\n\n" +
    "TRON NEWS ANALYSIS:\n" + newsAnalysis.tronThoughts + "\n\n" +
    "Respond ONLY with this JSON (no markdown, no backticks):\n" +
    '{"day":<n>,"date":"<DD.MM.YYYY>","portfolio":[{"ticker":"X","name":"N","shares":<n>,"buyPrice":<n>,"currentPrice":<n>,"value":<n>}],"cash":<n>,"totalValue":<n>,"pnl":<n>,"pnlPercent":<n>,"trades":[{"action":"BUY/SELL","ticker":"X","shares":<n>,"price":<n>,"total":<n>,"reason":"<detailed reason>","newsRef":"<exact headline>","priceTarget":<n>,"stopLoss":<n>}],"marketAnalysis":"<2-3 sentences using real price data>","strategy":"<plan>","mood":"bullish/bearish/neutral"}';

  const user = dayNum === 1
    ? "Day 1. EUR 500 cash, no positions. Invest aggressively using the live prices above. No ETFs."
    : "History:\n" + history + "\n\nDay " + dayNum + ". Use ONLY the live prices listed above.";

  return { system: system, user: user };
}

// ── HISTORY DATEI ─────────────────────────────────────────────────────────────
function updateHistory(day, newsAnalysis) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let entry = "\n---\n\n";
  entry += "## Tag " + day.day + " | " + day.date + "\n\n";
  entry += "**Portfolio:** EUR " + day.totalValue.toFixed(2) + " | P&L: " + (day.pnlPercent >= 0 ? "+" : "") + day.pnlPercent.toFixed(2) + "% | Cash: EUR " + day.cash.toFixed(2) + "\n\n";
  entry += "### Marktlage\n" + day.marketAnalysis + "\n\n";

  if (newsAnalysis) {
    entry += "### News-Zusammenfassung\n" + newsAnalysis.summary + "\n\n";
    if (newsAnalysis.keyEvents && newsAnalysis.keyEvents.length > 0) {
      entry += "### Wichtigste Ereignisse\n";
      newsAnalysis.keyEvents.forEach(function(e) {
        entry += "- **" + e.headline + "**\n";
        entry += "  - Auswirkung: " + e.impact + " | Betroffene Ticker: " + (e.affectedTickers || []).join(", ") + "\n";
        entry += "  - " + e.explanation + "\n";
      });
      entry += "\n";
    }
    entry += "### TRONs Gedanken\n" + newsAnalysis.tronThoughts + "\n\n";
  }

  if (day.trades && day.trades.length > 0) {
    entry += "### Trades\n";
    day.trades.forEach(function(t) {
      entry += "#### " + t.action + " " + t.ticker + " | " + t.shares + "x @ $" + t.price + " = EUR " + t.total + "\n";
      entry += "- **Begruendung:** " + t.reason + "\n";
      if (t.newsRef) entry += "- **Ausloesende News:** " + t.newsRef + "\n";
      if (t.priceTarget) entry += "- **Kursziel:** $" + t.priceTarget + "\n";
      if (t.stopLoss) entry += "- **Stop-Loss:** $" + t.stopLoss + "\n";
      entry += "\n";
    });
  } else {
    entry += "### Trades\nKeine Trades heute - Positionen gehalten.\n\n";
  }

  if (day.portfolio && day.portfolio.length > 0) {
    entry += "### Positionen\n| Ticker | Stueck | Einstieg | Aktuell | Wert | PnL |\n|---|---|---|---|---|---|\n";
    day.portfolio.forEach(function(p) {
      const pct = ((p.currentPrice - p.buyPrice) / p.buyPrice) * 100;
      entry += "| " + p.ticker + " | " + p.shares + " | $" + p.buyPrice + " | $" + p.currentPrice + " | EUR " + p.value.toFixed(2) + " | " + (pct >= 0 ? "+" : "") + pct.toFixed(2) + "% |\n";
    });
    entry += "\n";
  }

  fs.appendFileSync(HISTORY_FILE, entry);
}

// ── NEWS DATEI (taeglich neu) ─────────────────────────────────────────────────
function saveNewsReport(newsData, newsAnalysis, date) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let md = "# TRON News Report | " + date + "\n\n";
  md += "> Generiert: " + new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" }) + "\n\n";

  md += "## Zusammenfassung\n" + newsAnalysis.summary + "\n\n";
  md += "## TRONs Markteinschaetzung\n" + newsAnalysis.tronThoughts + "\n\n";

  if (newsAnalysis.keyEvents && newsAnalysis.keyEvents.length > 0) {
    md += "## Wichtigste News\n";
    newsAnalysis.keyEvents.forEach(function(e) {
      const icon = e.impact === "bullish" ? "+" : e.impact === "bearish" ? "-" : "~";
      md += "### [" + icon + "] " + e.headline + "\n";
      md += "- **Einfluss:** " + e.impact + "\n";
      if (e.affectedTickers && e.affectedTickers.length > 0) md += "- **Betroffene Aktien:** " + e.affectedTickers.join(", ") + "\n";
      md += "- " + e.explanation + "\n\n";
    });
  }

  if (newsAnalysis.tradingImplications && newsAnalysis.tradingImplications.length > 0) {
    md += "## Trading-Signale\n| Ticker | Signal | Dringlichkeit | Begruendung |\n|---|---|---|---|\n";
    newsAnalysis.tradingImplications.forEach(function(t) {
      md += "| " + t.ticker + " | " + t.action + " | " + t.urgency + " | " + t.reason + " |\n";
    });
    md += "\n";
  }

  md += "## Alle Headlines (" + newsData.marketNews.length + ")\n";
  newsData.marketNews.forEach(function(n) {
    md += "- " + n.headline + (n.source ? " *("+n.source+")*" : "") + "\n";
  });

  fs.writeFileSync(NEWS_FILE, md);
}

// ── README ────────────────────────────────────────────────────────────────────
function generateReadme(days, marketData, newsAnalysis) {
  const last = days[days.length - 1];
  if (!last) return;
  const progress = Math.min(((last.totalValue - 500) / 4500) * 100, 100);
  const filled = Math.round(progress / 5);
  const bar = "X".repeat(filled) + "-".repeat(20 - filled);

  let md = "# TRON Trading Bot\n\n";
  md += "> Echte Live-Daten: Yahoo Finance" + (FINNHUB_KEY ? " + Finnhub" : "") + " | " + new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" }) + "\n\n";
  md += "## Status: Tag " + days.length + "/30\n";
  md += "| | |\n|---|---|\n";
  md += "| Portfolio | EUR " + last.totalValue.toFixed(2) + " |\n";
  md += "| P&L | " + (last.pnlPercent >= 0 ? "+" : "") + last.pnlPercent.toFixed(2) + "% |\n";
  md += "| Cash | EUR " + last.cash.toFixed(2) + " |\n";
  md += "| Mood | " + (last.mood || "neutral") + " |\n\n";
  md += "```\nEUR 500 [" + bar + "] EUR 5000  (" + progress.toFixed(1) + "%)\n```\n\n";

  if (newsAnalysis) {
    md += "## News-Zusammenfassung\n" + newsAnalysis.summary + "\n\n";
    md += "## TRONs Gedanken\n" + newsAnalysis.tronThoughts + "\n\n";
  }

  if (last.trades && last.trades.length > 0) {
    md += "## Heutige Trades\n";
    last.trades.forEach(function(t) {
      md += "### " + t.action + " " + t.ticker + "\n";
      md += "- Menge: " + t.shares + "x @ $" + t.price + " = EUR " + t.total + "\n";
      md += "- Begruendung: " + t.reason + "\n";
      if (t.newsRef) md += "- News: " + t.newsRef + "\n";
      if (t.priceTarget) md += "- Kursziel: $" + t.priceTarget + " | Stop-Loss: $" + t.stopLoss + "\n";
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
    marketData.topGainers.slice(0, 5).forEach(function(p) { md += "- " + p.ticker + " +" + p.changePercent + "% @ $" + p.price + "\n"; });
    md += "\n";
  }
  if (marketData.topLosers && marketData.topLosers.length) {
    md += "## Top Verlierer\n";
    marketData.topLosers.slice(0, 5).forEach(function(p) { md += "- " + p.ticker + " " + p.changePercent + "% @ $" + p.price + "\n"; });
    md += "\n";
  }

  md += "## Verlauf\n| Tag | Datum | Wert | PnL% |\n|---|---|---|---|\n";
  days.forEach(function(d) {
    md += "| " + d.day + " | " + d.date + " | EUR " + d.totalValue.toFixed(2) + " | " + (d.pnlPercent >= 0 ? "+" : "") + d.pnlPercent.toFixed(2) + "% |\n";
  });

  md += "\n## Links\n";
  md += "- [Komplette Trade-History](data/history.md)\n";
  md += "- [Tages News-Report](data/news.md)\n";
  md += "- [System Log](data/log.md)\n";

  fs.writeFileSync("README.md", md);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
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
    appendLog("Challenge complete - 30 Handelstage abgeschlossen");
    process.exit(0);
  }

  appendLog("=== TRON DAY " + dayNum + " START ===");

  const portfolioTickers = state.days.length > 0 && state.days[state.days.length - 1].portfolio
    ? state.days[state.days.length - 1].portfolio.map(function(p) { return p.ticker; })
    : [];

  // 1. Live-Marktdaten laden
  const marketData = await buildMarketData(portfolioTickers);
  if (Object.keys(marketData.prices).length === 0) {
    appendLog("Keine Live-Kurse verfuegbar - Abbruch");
    process.exit(1);
  }

  // 2. News laden
  const newsData = await fetchAllNews(portfolioTickers);

  // 3. Claude analysiert News
  const newsAnalysis = await analyzeNews(newsData, marketData, dayNum);
  appendLog("News analysiert: " + newsAnalysis.summary.slice(0, 100) + "...");

  // 4. News Report speichern
  const todayStr = now.toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" });
  saveNewsReport(newsData, newsAnalysis, todayStr);

  // 5. Trading-Entscheidung
  const history = state.days.slice(-5).map(function(d) {
    return JSON.stringify({ day: d.day, totalValue: d.totalValue, portfolio: d.portfolio, trades: d.trades, strategy: d.strategy });
  }).join("\n");

  const prompt = buildTradingPrompt(dayNum, history, marketData, newsAnalysis);
  appendLog("TRON trifft Handelsentscheidungen...");

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
  parsed.newsAnalysis = newsAnalysis;

  state.days.push(parsed);
  saveState(state);
  updateHistory(parsed, newsAnalysis);
  generateReadme(state.days, marketData, newsAnalysis);

  appendLog("Portfolio: EUR " + parsed.totalValue.toFixed(2) + " | PnL: " + (parsed.pnlPercent >= 0 ? "+" : "") + parsed.pnlPercent.toFixed(2) + "%");
  if (parsed.trades) {
    parsed.trades.forEach(function(t) {
      appendLog(t.action + " " + t.ticker + " " + t.shares + "x @ $" + t.price + " | " + t.reason);
    });
  }
  appendLog("=== TRON DAY " + dayNum + " DONE ===");
}

main().catch(function(e) {
  appendLog("FATAL ERROR: " + e.message);
  process.exit(1);
});
