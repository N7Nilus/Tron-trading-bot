import Anthropic from “@anthropic-ai/sdk”;
import fs from “fs”;
import path from “path”;

const DATA_DIR = “./data”;
const STATE_FILE = path.join(DATA_DIR, “state.json”);
const LOG_FILE = path.join(DATA_DIR, “log.md”);

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── helpers ───────────────────────────────────────────────────────────────────
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
fs.appendFileSync(LOG_FILE, `- \`${new Date().toISOString()}` ${msg}\n`); console.log(msg); } function parseJson(text) { let parsed = null; try { parsed = JSON.parse(text.trim()); } catch {} if (!parsed) { try { parsed = JSON.parse(text.replace(/```json|```/gi, "").trim()); } catch {} } if (!parsed) { const s = text.indexOf("{"), e = text.lastIndexOf("}"); if (s !== -1 && e > s) try { parsed = JSON.parse(text.slice(s, e + 1)); } catch {} } if (!parsed) throw new Error(`No JSON. Preview: ${text.slice(0, 200)}`);
return parsed;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Feiertage ─────────────────────────────────────────────────────────────────
const HOLIDAYS = new Set([
“2026-04-03”,“2026-04-06”,
“2026-05-01”,“2026-05-14”,“2026-05-25”,“2026-05-26”,
“2026-07-04”,“2026-09-07”,“2026-11-26”,
“2026-12-25”,“2026-12-26”,
]);

function isTradingDay(date = new Date()) {
const day = date.getUTCDay();
if (day === 0 || day === 6) return false;
if (HOLIDAYS.has(date.toISOString().slice(0, 10))) return false;
return true;
}

const START_DATE = new Date(“2026-04-13T00:00:00Z”);

// ── Yahoo Finance ─────────────────────────────────────────────────────────────
async function fetchLivePrice(ticker) {
try {
const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=2d`;
const res = await fetch(url, { headers: { “User-Agent”: “Mozilla/5.0” } });
const data = await res.json();
const meta = data?.chart?.result?.[0]?.meta;
if (!meta?.regularMarketPrice) return null;
return {
ticker,
name: meta.shortName || ticker,
price: Math.round(meta.regularMarketPrice * 100) / 100,
previousClose: meta.previousClose || meta.chartPreviousClose,
change: meta.previousClose
? Math.round(((meta.regularMarketPrice - meta.previousClose) / meta.previousClose) * 10000) / 100
: 0,
volume: meta.regularMarketVolume || 0,
};
} catch { return null; }
}

async function fetchTrending() {
try {
const res = await fetch(“https://query1.finance.yahoo.com/v1/finance/trending/US?count=20”, { headers: { “User-Agent”: “Mozilla/5.0” } });
const data = await res.json();
return data?.finance?.result?.[0]?.quotes?.map(q => q.symbol) || [];
} catch { return []; }
}

async function fetchMovers(type = “gainers”) {
try {
const res = await fetch(`https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_${type}&count=20`, { headers: { “User-Agent”: “Mozilla/5.0” } });
const data = await res.json();
return data?.finance?.result?.[0]?.quotes?.map(q => q.symbol) || [];
} catch { return []; }
}

async function fetchMarketNews() {
const feeds = [
“https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC&region=US&lang=en-US”,
“https://feeds.finance.yahoo.com/rss/2.0/headline?s=^IXIC&region=US&lang=en-US”,
“https://feeds.finance.yahoo.com/rss/2.0/headline?s=BTC-USD&region=US&lang=en-US”,
];
const headlines = [];
for (const url of feeds) {
try {
const res = await fetch(url, { headers: { “User-Agent”: “Mozilla/5.0” } });
const xml = await res.text();
const titles = […xml.matchAll(/<title><![CDATA[(.*?)]]></title>/g)].map(m => m[1]);
const plain = […xml.matchAll(/<title>(.*?)</title>/g)].map(m => m[1]);
headlines.push(…[…titles, …plain].filter(t => !t.includes(“Yahoo”) && t.length > 10).slice(0, 5));
} catch {}
await sleep(300);
}
return […new Set(headlines)].slice(0, 20);
}

async function fetchTickerNews(ticker) {
try {
const res = await fetch(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${ticker}&region=US&lang=en-US`, { headers: { “User-Agent”: “Mozilla/5.0” } });
const xml = await res.text();
const titles = […xml.matchAll(/<title><![CDATA[(.*?)]]></title>/g)].map(m => m[1]);
const plain = […xml.matchAll(/<title>(.*?)</title>/g)].map(m => m[1]);
return […titles, …plain].filter(t => !t.includes(“Yahoo”) && t.length > 10).slice(0, 3);
} catch { return []; }
}

async function buildMarketData(portfolioTickers = []) {
appendLog(“Lade Trending-Aktien…”);
const [trending, gainers] = await Promise.all([fetchTrending(), fetchMovers(“gainers”)]);
const base = [“NVDA”,“TSLA”,“AMD”,“META”,“AMZN”,“GOOGL”,“MSFT”,“AAPL”,“MSTR”,“SOXL”,“TQQQ”,“BTC-USD”,“ETH-USD”,“SOL-USD”];
const candidates = […new Set([…portfolioTickers, …trending, …gainers, …base])].slice(0, 40);

appendLog(`${candidates.length} Ticker gefunden, lade Kurse...`);
const prices = {};
for (const t of candidates) {
const p = await fetchLivePrice(t);
if (p) prices[t] = p;
await sleep(200);
}
appendLog(`${Object.keys(prices).length} Live-Kurse geladen`);

const sorted = Object.values(prices).sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
return {
prices,
topGainers: sorted.filter(p => p.change > 0).slice(0, 5),
topLosers: sorted.filter(p => p.change < 0).slice(0, 5),
trending: trending.slice(0, 10),
};
}

async function buildNewsDigest(portfolioTickers = []) {
appendLog(“Lade Marktnews…”);
const marketNews = await fetchMarketNews();
const tickerNews = {};
for (const t of portfolioTickers.slice(0, 5)) {
const news = await fetchTickerNews(t);
if (news.length) tickerNews[t] = news;
await sleep(300);
}
return { marketNews, tickerNews };
}

// ── Prompt ────────────────────────────────────────────────────────────────────
function buildPrompt(dayNum, history, marketData, news) {
const { prices, topGainers, topLosers, trending } = marketData;
const { marketNews, tickerNews } = news;

const priceLines = Object.values(prices)
.sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
.map(p => `${p.ticker} (${p.name}): $${p.price} | ${p.change >= 0 ? "+" : ""}${p.change}% | Vol: ${(p.volume / 1e6).toFixed(1)}M`)
.join(”\n”);

const system = `You are TRON, an AI character in a fictional stock market simulation game. No real financial advice.

TRON has a fictional €500 starting capital and wants to reach €5000. Be aggressive and dramatic.

TODAY’S REAL MARKET DATA (Yahoo Finance):
TOP GAINERS: ${topGainers.map(p => `${p.ticker} +${p.change}%`).join(”, “) || “N/A”}
TOP LOSERS: ${topLosers.map(p => `${p.ticker} ${p.change}%`).join(”, “) || “N/A”}
TRENDING: ${trending.join(”, “) || “N/A”}

ALL LIVE PRICES:
${priceLines}

MARKET NEWS:
${marketNews.slice(0, 15).map(n => `- ${n}`).join(”\n”) || “None”}

TICKER NEWS:
${Object.entries(tickerNews).map(([t, items]) => `${t}: ${items.join(" | ")}`).join(”\n”) || “None”}

RULES:

- Only trade tickers from the live prices list
- Use exact current prices
- Base decisions on BOTH price movements AND news
- Reference specific news in each trade reason

Respond ONLY with this JSON (no markdown, no backticks):
{
“day”: <number>,
“date”: “<DD.MM.YYYY>”,
“portfolio”: [{“ticker”:“X”,“name”:“Name”,“shares”:<n>,“buyPrice”:<n>,“currentPrice”:<n>,“value”:<n>}],
“cash”: <number>,
“totalValue”: <number>,
“pnl”: <number>,
“pnlPercent”: <number>,
“trades”: [{“action”:“BUY/SELL”,“ticker”:“X”,“shares”:<n>,“price”:<n>,“total”:<n>,“reason”:”<reasoning referencing news and price movement>”}],
“marketAnalysis”: “<2-3 sentences about today’s market>”,
“strategy”: “<TRON plan>”,
“mood”: “bullish/bearish/neutral”
}`;

const user = dayNum === 1
? `Day 1. Cash: 500 EUR, no positions. Goal: 500->5000 EUR. Make first aggressive trades.`
: `History:\n${history}\n\nDay ${dayNum}. Update portfolio prices. Make new decisions based on today's data.`;

return { system, user };
}

// ── README ────────────────────────────────────────────────────────────────────
function generateReadme(days, marketData, news) {
const last = days[days.length - 1];
if (!last) return;
const progress = Math.min(((last.totalValue - 500) / 4500) * 100, 100);
const bar = “█”.repeat(Math.round(progress / 5)) + “░”.repeat(20 - Math.round(progress / 5));
const { topGainers, topLosers } = marketData;
const { marketNews } = news;

let md = `# TRON Trading Bot — EUR 500 to EUR 5000 Challenge\n\n`;
md += `> Live data from Yahoo Finance | Updated: ${new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" })}\n\n`;
md += `## Status: Day ${days.length}/30\n`;
md += `| | |\n|---|---|\n`;
md += `| **Portfolio** | EUR ${last.totalValue.toFixed(2)} |\n`;
md += `| **P&L** | ${last.pnlPercent >= 0 ? "+" : ""}${last.pnlPercent.toFixed(2)}% |\n`;
md += `| **Cash** | EUR ${last.cash.toFixed(2)} |\n`;
md += `| **Mood** | ${{ bullish: "Bullish", bearish: "Bearish", neutral: "Neutral" }[last.mood] || last.mood} |\n\n`;
md += `\```\nEUR 500 [${bar}] EUR 5000  (${progress.toFixed(1)}%)\n```\n\n`;

if (topGainers?.length) {
md += `## Top Gainers\n`;
topGainers.forEach(p => md += `- [${p.ticker}](https://finance.yahoo.com/quote/${p.ticker}) +${p.change}% @ $${p.price}\n`);
md += “\n”;
}
if (topLosers?.length) {
md += `## Top Losers\n`;
topLosers.forEach(p => md += `- [${p.ticker}](https://finance.yahoo.com/quote/${p.ticker}) ${p.change}% @ $${p.price}\n`);
md += “\n”;
}
if (marketNews?.length) {
md += `## Market News\n`;
marketNews.slice(0, 8).forEach(n => md += `- ${n}\n`);
md += “\n”;
}

md += `## Market Analysis\n${last.marketAnalysis}\n\n`;

if (last.portfolio?.length) {
md += `## Positions\n| Ticker | Shares | Buy | Current | Value | P&L |\n|---|---|---|---|---|---|\n`;
last.portfolio.forEach(p => {
const pct = ((p.currentPrice - p.buyPrice) / p.buyPrice) * 100;
md += `| [${p.ticker}](https://finance.yahoo.com/quote/${p.ticker}) | ${p.shares} | $${p.buyPrice} | $${p.currentPrice} | EUR ${p.value.toFixed(2)} | ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% |\n`;
});
md += “\n”;
}

if (last.trades?.length) {
md += `## Today's Trades\n`;
last.trades.forEach(t => {
md += `- **${t.action}** [${t.ticker}](https://finance.yahoo.com/quote/${t.ticker}) ${t.shares}x @ $${t.price} = EUR ${t.total}\n  > ${t.reason}\n`;
});
md += “\n”;
}

md += `## History\n| Day | Date | Value | P&L% |\n|---|---|---|---|\n`;
days.forEach(d => {
md += `| ${d.day} | ${d.date} | EUR ${d.totalValue.toFixed(2)} | ${d.pnlPercent >= 0 ? "+" : ""}${d.pnlPercent.toFixed(2)}% |\n`;
});

fs.writeFileSync(“README.md”, md);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
const now = new Date();

if (now < START_DATE) {
appendLog(`Challenge startet am 13.04.2026`);
process.exit(0);
}

if (!isTradingDay(now)) {
const dayName = [“Sonntag”,“Montag”,“Dienstag”,“Mittwoch”,“Donnerstag”,“Freitag”,“Samstag”][now.getUTCDay()];
appendLog(`${dayName} kein Handelstag - TRON pausiert`);
process.exit(0);
}

const state = loadState();
const dayNum = state.days.length + 1;

if (dayNum > 30) {
appendLog(“Challenge complete - 30 days done”);
process.exit(0);
}

appendLog(`=== TRON DAY ${dayNum} START ===`);

const portfolioTickers = state.days[state.days.length - 1]?.portfolio?.map(p => p.ticker) || [];

const [marketData, news] = await Promise.all([
buildMarketData(portfolioTickers),
buildNewsDigest(portfolioTickers),
]);

if (Object.keys(marketData.prices).length === 0) {
appendLog(“No live prices available - aborting”);
process.exit(1);
}

appendLog(`${news.marketNews.length} news headlines loaded`);

const history = state.days.slice(-3).map(d =>
JSON.stringify({ day: d.day, totalValue: d.totalValue, portfolio: d.portfolio, trades: d.trades, strategy: d.strategy })
).join(”\n”);

const { system, user } = buildPrompt(dayNum, history, marketData, news);

appendLog(“TRON analysiert Kurse und News…”);

const msg = await client.messages.create({
model: “claude-sonnet-4-20250514”,
max_tokens: 1500,
system,
messages: [{ role: “user”, content: user }],
});

const text = msg.content.filter(b => b.type === “text”).map(b => b.text).join(””);
const parsed = parseJson(text);
parsed.day = dayNum;
parsed.livePricesSnapshot = marketData.prices;

state.days.push(parsed);
saveState(state);

appendLog(`Portfolio: EUR ${parsed.totalValue.toFixed(2)} (${parsed.pnlPercent >= 0 ? "+" : ""}${parsed.pnlPercent.toFixed(2)}%) | Cash: EUR ${parsed.cash.toFixed(2)}`);
appendLog(`Markt: ${parsed.marketAnalysis}`);
(parsed.trades || []).forEach(t =>
appendLog(`${t.action} ${t.ticker}: ${t.shares}x @ $${t.price} = EUR ${t.total} | ${t.reason}`)
);
appendLog(`Strategie: ${parsed.strategy}`);

generateReadme(state.days, marketData, news);
}

main().catch(e => {
appendLog(`ERROR: ${e.message}`);
process.exit(1);
});