const Anthropic = require(”@anthropic-ai/sdk”);
const fs = require(“fs”);
const path = require(“path”);

const DATA_DIR = “./data”;
const STATE_FILE = path.join(DATA_DIR, “state.json”);
const LOG_FILE = path.join(DATA_DIR, “log.md”);

const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

function loadState() {
try { return JSON.parse(fs.readFileSync(STATE_FILE, “utf8”)); }
catch { return { days: [] }; }
}
function saveState(s) {
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
function appendLog(msg) {
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.appendFileSync(LOG_FILE, “- `" + new Date().toISOString() + "` “ + msg + “\n”);
console.log(msg);
}
function parseJson(text) {
let parsed = null;
try { parsed = JSON.parse(text.trim()); } catch(e) {}
if (!parsed) { try { parsed = JSON.parse(text.replace(/`json|`/gi, “”).trim()); } catch(e) {} }
if (!parsed) {
const s = text.indexOf(”{”);
const e = text.lastIndexOf(”}”);
if (s !== -1 && e > s) { try { parsed = JSON.parse(text.slice(s, e + 1)); } catch(e) {} }
}
if (!parsed) throw new Error(“No JSON found. Preview: “ + text.slice(0, 200));
return parsed;
}
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

const HOLIDAYS = [
“2026-04-03”,“2026-04-06”,“2026-05-01”,“2026-05-14”,
“2026-05-25”,“2026-05-26”,“2026-07-04”,“2026-09-07”,
“2026-11-26”,“2026-12-25”,“2026-12-26”
];

function isTradingDay(date) {
const day = date.getUTCDay();
if (day === 0 || day === 6) return false;
const str = date.toISOString().slice(0, 10);
if (HOLIDAYS.indexOf(str) !== -1) return false;
return true;
}

const START_DATE = new Date(“2026-04-13T00:00:00Z”);

async function fetchLivePrice(ticker) {
try {
const url = “https://query1.finance.yahoo.com/v8/finance/chart/” + ticker + “?interval=1d&range=2d”;
const res = await fetch(url, { headers: { “User-Agent”: “Mozilla/5.0” } });
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
volume: meta.regularMarketVolume || 0
};
} catch(e) { return null; }
}

async function fetchTrending() {
try {
const res = await fetch(“https://query1.finance.yahoo.com/v1/finance/trending/US?count=20”, { headers: { “User-Agent”: “Mozilla/5.0” } });
const data = await res.json();
return data.finance.result[0].quotes.map(function(q) { return q.symbol; });
} catch(e) { return []; }
}

async function fetchMovers(type) {
try {
const url = “https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_” + type + “&count=20”;
const res = await fetch(url, { headers: { “User-Agent”: “Mozilla/5.0” } });
const data = await res.json();
return data.finance.result[0].quotes.map(function(q) { return q.symbol; });
} catch(e) { return []; }
}

async function fetchMarketNews() {
const feeds = [
“https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC&region=US&lang=en-US”,
“https://feeds.finance.yahoo.com/rss/2.0/headline?s=^IXIC&region=US&lang=en-US”,
“https://feeds.finance.yahoo.com/rss/2.0/headline?s=BTC-USD&region=US&lang=en-US”
];
const headlines = [];
for (let i = 0; i < feeds.length; i++) {
try {
const res = await fetch(feeds[i], { headers: { “User-Agent”: “Mozilla/5.0” } });
const xml = await res.text();
const matches = xml.match(/<title>[^<]{10,}</title>/g) || [];
matches.forEach(function(m) {
const t = m.replace(/</?title>/g, “”).replace(/<![CDATA[|]]>/g, “”).trim();
if (t && t.indexOf(“Yahoo”) === -1) headlines.push(t);
});
} catch(e) {}
await sleep(300);
}
const unique = headlines.filter(function(v, i, a) { return a.indexOf(v) === i; });
return unique.slice(0, 20);
}

async function buildMarketData(portfolioTickers) {
appendLog(“Lade Trending-Aktien…”);
const trending = await fetchTrending();
const gainers = await fetchMovers(“gainers”);
const base = [“NVDA”,“TSLA”,“AMD”,“META”,“AMZN”,“GOOGL”,“MSFT”,“AAPL”,“MSTR”,“SOXL”,“TQQQ”,“BTC-USD”,“ETH-USD”,“SOL-USD”];
const all = portfolioTickers.concat(trending).concat(gainers).concat(base);
const candidates = all.filter(function(v, i, a) { return a.indexOf(v) === i; }).slice(0, 40);

appendLog(candidates.length + “ Ticker gefunden, lade Kurse…”);
const prices = {};
for (let i = 0; i < candidates.length; i++) {
const p = await fetchLivePrice(candidates[i]);
if (p) prices[candidates[i]] = p;
await sleep(200);
}
appendLog(Object.keys(prices).length + “ Live-Kurse geladen”);

const sorted = Object.values(prices).sort(function(a, b) { return Math.abs(b.change) - Math.abs(a.change); });
return {
prices: prices,
topGainers: sorted.filter(function(p) { return p.change > 0; }).slice(0, 5),
topLosers: sorted.filter(function(p) { return p.change < 0; }).slice(0, 5),
trending: trending.slice(0, 10)
};
}

async function buildNewsDigest(portfolioTickers) {
appendLog(“Lade Marktnews…”);
const marketNews = await fetchMarketNews();
return { marketNews: marketNews, tickerNews: {} };
}

function buildPrompt(dayNum, history, marketData, news) {
const prices = marketData.prices;
const topGainers = marketData.topGainers;
const topLosers = marketData.topLosers;
const trending = marketData.trending;
const marketNews = news.marketNews;

const priceLines = Object.values(prices)
.sort(function(a, b) { return Math.abs(b.change) - Math.abs(a.change); })
.map(function(p) {
return p.ticker + “ (” + p.name + “): $” + p.price + “ | “ + (p.change >= 0 ? “+” : “”) + p.change + “% | Vol: “ + (p.volume / 1e6).toFixed(1) + “M”;
}).join(”\n”);

const gainersLine = topGainers.map(function(p) { return p.ticker + “ +” + p.change + “%”; }).join(”, “);
const losersLine = topLosers.map(function(p) { return p.ticker + “ “ + p.change + “%”; }).join(”, “);
const newsLines = marketNews.slice(0, 15).map(function(n) { return “- “ + n; }).join(”\n”);

const system = “You are TRON, an AI character in a fictional stock market simulation game. No real financial advice.\n\n” +
“TRON has fictional EUR 500 starting capital and wants to reach EUR 5000. Be aggressive.\n\n” +
“TODAY LIVE PRICES (Yahoo Finance):\n” +
“TOP GAINERS: “ + (gainersLine || “N/A”) + “\n” +
“TOP LOSERS: “ + (losersLine || “N/A”) + “\n” +
“TRENDING: “ + (trending.join(”, “) || “N/A”) + “\n\n” +
“ALL LIVE PRICES:\n” + priceLines + “\n\n” +
“MARKET NEWS:\n” + (newsLines || “None”) + “\n\n” +
“RULES:\n” +
“- Only trade tickers from the live prices list\n” +
“- Use exact current prices\n” +
“- Reference news in trade reasons\n\n” +
“Respond ONLY with this JSON (no markdown, no backticks):\n” +
‘{“day”:<n>,“date”:”<DD.MM.YYYY>”,“portfolio”:[{“ticker”:“X”,“name”:“N”,“shares”:<n>,“buyPrice”:<n>,“currentPrice”:<n>,“value”:<n>}],“cash”:<n>,“totalValue”:<n>,“pnl”:<n>,“pnlPercent”:<n>,“trades”:[{“action”:“BUY/SELL”,“ticker”:“X”,“shares”:<n>,“price”:<n>,“total”:<n>,“reason”:”<reason>”}],“marketAnalysis”:”<text>”,“strategy”:”<text>”,“mood”:“bullish/bearish/neutral”}’;

const user = dayNum === 1
? “Day 1. Cash: 500 EUR, no positions. Goal: 500 to 5000 EUR. Make first aggressive trades.”
: “History:\n” + history + “\n\nDay “ + dayNum + “. Update prices, make new decisions.”;

return { system: system, user: user };
}

function generateReadme(days, marketData, news) {
const last = days[days.length - 1];
if (!last) return;
const progress = Math.min(((last.totalValue - 500) / 4500) * 100, 100);
const filled = Math.round(progress / 5);
const bar = “X”.repeat(filled) + “-”.repeat(20 - filled);

let md = “# TRON Trading Bot - EUR 500 to EUR 5000\n\n”;
md += “> Live data: Yahoo Finance | “ + new Date().toLocaleString(“de-DE”, { timeZone: “Europe/Berlin” }) + “\n\n”;
md += “## Day “ + days.length + “/30\n”;
md += “| | |\n|—|—|\n”;
md += “| Portfolio | EUR “ + last.totalValue.toFixed(2) + “ |\n”;
md += “| P&L | “ + (last.pnlPercent >= 0 ? “+” : “”) + last.pnlPercent.toFixed(2) + “% |\n”;
md += “| Cash | EUR “ + last.cash.toFixed(2) + “ |\n”;
md += “| Mood | “ + (last.mood || “neutral”) + “ |\n\n”;
md += “`\nEUR 500 [" + bar + "] EUR 5000  (" + progress.toFixed(1) + "%)\n`\n\n”;

if (marketData.topGainers && marketData.topGainers.length) {
md += “## Top Gainers\n”;
marketData.topGainers.forEach(function(p) { md += “- “ + p.ticker + “ +” + p.change + “% @ $” + p.price + “\n”; });
md += “\n”;
}

if (news.marketNews && news.marketNews.length) {
md += “## News\n”;
news.marketNews.slice(0, 8).forEach(function(n) { md += “- “ + n + “\n”; });
md += “\n”;
}

md += “## Analysis\n” + (last.marketAnalysis || “”) + “\n\n”;

if (last.portfolio && last.portfolio.length) {
md += “## Positions\n| Ticker | Shares | Buy | Current | Value | PnL |\n|—|—|—|—|—|—|\n”;
last.portfolio.forEach(function(p) {
const pct = ((p.currentPrice - p.buyPrice) / p.buyPrice) * 100;
md += “| “ + p.ticker + “ | “ + p.shares + “ | $” + p.buyPrice + “ | $” + p.currentPrice + “ | EUR “ + p.value.toFixed(2) + “ | “ + (pct >= 0 ? “+” : “”) + pct.toFixed(2) + “% |\n”;
});
md += “\n”;
}

if (last.trades && last.trades.length) {
md += “## Trades Today\n”;
last.trades.forEach(function(t) {
md += “- “ + t.action + “ “ + t.ticker + “ “ + t.shares + “x @ $” + t.price + “ = EUR “ + t.total + “\n  > “ + t.reason + “\n”;
});
md += “\n”;
}

md += “## History\n| Day | Date | Value | PnL% |\n|—|—|—|—|\n”;
days.forEach(function(d) {
md += “| “ + d.day + “ | “ + d.date + “ | EUR “ + d.totalValue.toFixed(2) + “ | “ + (d.pnlPercent >= 0 ? “+” : “”) + d.pnlPercent.toFixed(2) + “% |\n”;
});

fs.writeFileSync(“README.md”, md);
}

async function main() {
const now = new Date();

if (now < START_DATE) {
appendLog(“Challenge starts 13.04.2026”);
process.exit(0);
}

if (!isTradingDay(now)) {
appendLog(“Not a trading day - TRON paused”);
process.exit(0);
}

const state = loadState();
const dayNum = state.days.length + 1;

if (dayNum > 30) {
appendLog(“Challenge complete - 30 days done”);
process.exit(0);
}

appendLog(”=== TRON DAY “ + dayNum + “ START ===”);

const portfolioTickers = state.days.length > 0 && state.days[state.days.length - 1].portfolio
? state.days[state.days.length - 1].portfolio.map(function(p) { return p.ticker; })
: [];

const marketData = await buildMarketData(portfolioTickers);
const news = await buildNewsDigest(portfolioTickers);

if (Object.keys(marketData.prices).length === 0) {
appendLog(“No live prices - aborting”);
process.exit(1);
}

const history = state.days.slice(-3).map(function(d) {
return JSON.stringify({ day: d.day, totalValue: d.totalValue, portfolio: d.portfolio, trades: d.trades, strategy: d.strategy });
}).join(”\n”);

const prompt = buildPrompt(dayNum, history, marketData, news);

appendLog(“TRON analysiert…”);

const msg = await client.messages.create({
model: “claude-sonnet-4-20250514”,
max_tokens: 1500,
system: prompt.system,
messages: [{ role: “user”, content: prompt.user }]
});

const text = msg.content.filter(function(b) { return b.type === “text”; }).map(function(b) { return b.text; }).join(””);
const parsed = parseJson(text);
parsed.day = dayNum;
parsed.livePricesSnapshot = marketData.prices;

state.days.push(parsed);
saveState(state);

appendLog(“Portfolio: EUR “ + parsed.totalValue.toFixed(2) + “ (” + (parsed.pnlPercent >= 0 ? “+” : “”) + parsed.pnlPercent.toFixed(2) + “%) | Cash: EUR “ + parsed.cash.toFixed(2));
if (parsed.trades) {
parsed.trades.forEach(function(t) {
appendLog(t.action + “ “ + t.ticker + “: “ + t.shares + “x @ $” + t.price + “ = EUR “ + t.total + “ | “ + t.reason);
});
}
appendLog(“Strategy: “ + parsed.strategy);

generateReadme(state.days, marketData, news);
}

main().catch(function(e) {
appendLog(“ERROR: “ + e.message);
process.exit(1);
});