import Anthropic from “@anthropic-ai/sdk”;
import fs from “fs”;
import path from “path”;

const DATA_DIR = “./data”;
const STATE_FILE = path.join(DATA_DIR, “state.json”);
const LOG_FILE = path.join(DATA_DIR, “log.md”);

const BOT_NAME = “TRON”;
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

// ── News via Yahoo Finance RSS ────────────────────────────────────────────────
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
const plain  = […xml.matchAll(/<title>(.*?)</title>/g)].map(m => m[1]);
const all = […titles, …plain].filter(t => !t.includes(“Yahoo Finance”) && t.length > 10);
headlines.push(…all.slice(0, 5));
} catch {}
await sleep(300);
}
return […new Set(headlines)].slice(0, 20);
}

async function fetchTickerNews(ticker) {
try {
const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${ticker}&region=US&lang=en-US`;
const res = await fetch(url, { headers: { “User-Agent”: “Mozilla/5.0” } });
const xml = await res.text();
const titles = […xml.matchAll(/<title><![CDATA[(.*?)]]></title>/g)].map(m => m[1]);
const plain  = […xml.matchAll(/<title>(.*?)</title>/g)].map(m => m[1]);
return […titles, …plain].filter(t => !t.includes(“Yahoo”) && t.length > 10).slice(0, 3);
} catch { return []; }
}

// ── Yahoo Finance: trending + movers ─────────────────────────────────────────
async function fetchTrending() {
try {
const url = “https://query1.finance.yahoo.com/v1/finance/trending/US?count=20”;
const res = await fetch(url, { headers: { “User-Agent”: “Mozilla/5.0” } });
const data = await res.json();
return data?.finance?.result?.[0]?.quotes?.map(q => q.symbol) || [];
} catch { return []; }
}

async function fetchMovers(type = “gainers”) {
try {
const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_${type}&count=20`;
const res = await fetch(url, { headers: { “User-Agent”: “Mozilla/5.0” } });
const data = await res.json();
return data?.finance?.result?.[0]?.quotes?.map(q => q.symbol) || [];
} catch { return []; }
}

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
marketCap: meta.marketCap || 0,
};
} catch { return null; }
}

// ── Build full market picture ─────────────────────────────────────────────────
async function buildMarketData(existingPortfolioTickers = []) {
appendLog(“📡 Lade Trending-Aktien…”);
const [trending, gainers, losers] = await Promise.all([
fetchTrending(),
fetchMovers(“gainers”),
fetchMovers(“losers”),
]);

// Combine all candidates — deduplicated
const base = [“NVDA”,“TSLA”,“AMD”,“META”,“AMZN”,“GOOGL”,“MSFT”,“AAPL”,“MSTR”,“SOXL”,“TQQQ”,“BTC-USD”,“ETH-USD”,“SOL-USD”];
const candidates = […new Set([…existingPortfolioTickers, …trending, …gainers, …base])].slice(0, 40);

appendLog(`📊 ${candidates.length} Ticker gefunden (Trending: ${trending.length}, Gainers: ${gainers.length})`);
appendLog(“💹 Lade Live-Kurse…”);

const prices = {};
for (const t of candidates) {
const p = await fetchLivePrice(t);
if (p) prices[t] = p;
await sleep(200);
}

appendLog(`✅ ${Object.keys(prices).length} Live-Kurse geladen`);

// Top movers for summary
const sorted = Object.values(prices).sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
const topGainers = sorted.filter(p => p.change > 0).slice(0, 5);
const topLosers  = sorted.filter(p => p.change < 0).slice(0, 5);

return { prices, topGainers, topLosers, trending: trending.slice(0, 10) };
}

// ── News aggregation ──────────────────────────────────────────────────────────
async function buildNewsDigest(portfolioTickers) {
appendLog(“📰 Lade Marktnews…”);
const marketNews = await fetchMarketNews();

const tickerNews = {};
for (const t of portfolioTickers.slice(0, 5)) {
const news = await fetchTickerNews(t);
if (news.length) tickerNews[t] = news;
await sleep(300);
}

return { marketNews, tickerNews };
}

// ── prompt builder ────────────────────────────────────────────────────────────
function buildPrompt(dayNum, history, marketData, news) {
const { prices, topGainers, topLosers, trending } = marketData;
const { marketNews, tickerNews } = news;

const priceLines = Object.values(prices)
.sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
.map(p => `${p.ticker} (${p.name}): $${p.price} | ${p.change >= 0 ? "+" : ""}${p.change}% | Vol: ${(p.volume/1e6).toFixed(1)}M`)
.join(”\n”);

const gainersLine = topGainers.map(p => `${p.ticker} +${p.change}%`).join(”, “);
const losersLine  = topLosers.map(p => `${p.ticker} ${p.change}%`).join(”, “);
const trendingLine = trending.join(”, “);
const newsLines = marketNews.slice(0, 15).map(n => `• ${n}`).join(”\n”);
const tickerNewsLines = Object.entries(tickerNews)
.map(([t, items]) => `${t}: ${items.join(" | ")}`)
.join(”\n”);

const system = `You are ARIA, an AI character in a fictional stock market simulation game. No real financial advice — this is creative storytelling.

ARIA has €500 starting capital and wants to reach €5000. Be aggressive and dramatic.

TODAY’S REAL MARKET DATA (from Yahoo Finance):

📈 TOP GAINERS: ${gainersLine || “N/A”}
📉 TOP LOSERS: ${losersLine || “N/A”}
🔥 TRENDING: ${trendingLine || “N/A”}

ALL LIVE PRICES:
${priceLines}

📰 MARKET NEWS:
${newsLines || “No news available”}

📰 TICKER-SPECIFIC NEWS:
${tickerNewsLines || “None”}

RULES:

- Only trade tickers listed in LIVE PRICES above
- Use exact current prices shown
- Base decisions on BOTH price movements AND news headlines
- Explain which news influenced each trade decision

Respond ONLY with this JSON (no markdown, no backticks):
{
“day”: <number>,
“date”: “<DD.MM.YYYY>”,
“portfolio”: [{“ticker”:“X”,“name”:“Name”,“shares”:<n>,“buyPrice”:<n>,“currentPrice”:<n>,“value”:<n>}],
“cash”: <number>,
“totalValue”: <number>,
“pnl”: <number>,
“pnlPercent”: <number>,
“trades”: [{“action”:“BUY/SELL”,“ticker”:“X”,“shares”:<n>,“price”:<n>,“total”:<n>,“reason”:”<reasoning referencing specific news and price movement>”}],
“marketAnalysis”: “<2-3 sentences about today’s market based on real news>”,
“strategy”: “<ARIA plan based on live data and news>”,
“mood”: “bullish/bearish/neutral”
}`;

const user = dayNum === 1
? `Day 1. Cash: €500, no positions. Analyze the live data and news. Make first aggressive trades.`
: `History:\n${history}\n\nDay ${dayNum}. Update portfolio with current live prices. Make new decisions based on today's news and movers.`;

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

let md = `# 🤖 ARIA Trading Bot — €500 → €5.000 Challenge\n\n`;
md += `> Live-Kurse & News von **Yahoo Finance** | Update: ${new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" })}\n\n`;
md += `## 📊 Status: Tag ${days.length}/30\n`;
md += `| | |\n|---|---|\n`;
md += `| **Portfoliowert** | €${last.totalValue.toFixed(2)} |\n`;
md += `| **P&L** | ${last.pnlPercent >= 0 ? "+" : ""}${last.pnlPercent.toFixed(2)}% |\n`;
md += `| **Cash** | €${last.cash.toFixed(2)} |\n`;
md += `| **Mood** | ${{ bullish: "🐂 Bullish", bearish: "🐻 Bearish", neutral: "😐 Neutral" }[last.mood] || last.mood} |\n\n`;
md += `\```\n€500 [${bar}] €5.000  (${progress.toFixed(1)}%)\n```\n\n`;

if (topGainers?.length) {
md += `## 📈 Top Gewinner heute\n`;
topGainers.forEach(p => md += `- [${p.ticker}](https://finance.yahoo.com/quote/${p.ticker}) **+${p.change}%** @ $${p.price}\n`);
md += “\n”;
}
if (topLosers?.length) {
md += `## 📉 Top Verlierer heute\n`;
topLosers.forEach(p => md += `- [${p.ticker}](https://finance.yahoo.com/quote/${p.ticker}) **${p.change}%** @ $${p.price}\n`);
md += “\n”;
}
if (marketNews?.length) {
md += `## 📰 Marktnews heute\n`;
marketNews.slice(0, 8).forEach(n => md += `- ${n}\n`);
md += “\n”;
}

md += `## 📰 Marktanalyse\n${last.marketAnalysis}\n\n`;

if (last.portfolio?.length) {
md += `## 💼 Positionen\n| Ticker | Stk | Einstieg | Aktuell | Wert | P&L |\n|---|---|---|---|---|---|\n`;
last.portfolio.forEach(p => {
const pct = ((p.currentPrice - p.buyPrice) / p.buyPrice) * 100;
md += `| [${p.ticker}](https://finance.yahoo.com/quote/${p.ticker}) | ${p.shares} | $${p.buyPrice} | $${p.currentPrice} | €${p.value.toFixed(2)} | ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% |\n`;
});
md += “\n”;
}

if (last.trades?.length) {
md += `## 💱 Trades heute\n`;
last.trades.forEach(t => {
md += `- **${t.action}** [${t.ticker}](https://finance.yahoo.com/quote/${p.ticker}) — ${t.shares}× @ $${t.price} = €${t.total}\n  > ${t.reason}\n`;
});
md += “\n”;
}

md += `## 📈 Verlauf\n| Tag | Datum | Wert | P&L% |\n|---|---|---|---|\n`;
days.forEach(d => {
md += `| ${d.day} | ${d.date} | €${d.totalValue.toFixed(2)} | ${d.pnlPercent >= 0 ? "+" : ""}${d.pnlPercent.toFixed(2)}% |\n`;
});

fs.writeFileSync(“README.md”, md);
}

// ── main ──────────────────────────────────────────────────────────────────────
// Feiertage 2025/2026 (DE + US gemeinsam) — kein Handel
const HOLIDAYS = new Set([
“2026-04-03”,“2026-04-06”, // Karfreitag, Ostermontag
“2026-05-01”,              // Tag der Arbeit
“2026-05-14”,              // Christi Himmelfahrt
“2026-05-25”,              // Pfingstmontag
“2026-05-26”,              // Memorial Day (US)
“2026-07-04”,              // Independence Day (US)
“2026-09-07”,              // Labor Day (US)
“2026-11-26”,              // Thanksgiving (US)
“2026-12-25”,“2026-12-26”, // Weihnachten
]);

function isTradingDay(date = new Date()) {
const day = date.getUTCDay(); // 0=So, 6=Sa
if (day === 0 || day === 6) return false;
const str = date.toISOString().slice(0, 10);
if (HOLIDAYS.has(str)) return false;
return true;
}

// Start date: 13.04.2026
const START_DATE = new Date(“2026-04-13T00:00:00Z”);

async function main() {
const now = new Date();

// Not started yet?
if (now < START_DATE) {
appendLog(`⏳ Challenge startet am 13.04.2026 — heute ist noch nicht soweit`);
process.exit(0);
}

// Is today a trading day?
if (!isTradingDay(now)) {
const dayName = [“Sonntag”,“Montag”,“Dienstag”,“Mittwoch”,“Donnerstag”,“Freitag”,“Samstag”][now.getUTCDay()];
appendLog(`📅 Heute (${dayName}) kein Handelstag — ARIA pausiert`);
process.exit(0);
}

const state = loadState();
const dayNum = state.days.length + 1;

if (dayNum > 30) {
appendLog(“✅ 30-Tage-Challenge abgeschlossen!”);
process.exit(0);
}

appendLog(`━━━ TRON DAY ${dayNum} START ━━━`);

const portfolioTickers = state.days[state.days.length - 1]?.portfolio?.map(p => p.ticker) || [];

// Load market data + news in parallel
const [marketData, news] = await Promise.all([
buildMarketData(portfolioTickers),
buildNewsDigest(portfolioTickers),
]);

if (Object.keys(marketData.prices).length === 0) {
appendLog(“❌ Keine Live-Kurse — Abbruch”);
process.exit(1);
}

appendLog(`📰 ${news.marketNews.length} News-Headlines geladen`);

const history = state.days.slice(-3).map(d =>
JSON.stringify({ day: d.day, totalValue: d.totalValue, portfolio: d.portfolio, trades: d.trades, strategy: d.strategy })
).join(”\n”);

const { system, user } = buildPrompt(dayNum, history, marketData, news);

appendLog(“🤖 ARIA analysiert Kurse + News…”);
const msg = await client.messages.create({
model: “claude-sonnet-4-20250514”,
max_tokens: 1500,
system,
messages: [{ role: “user”, content: user }],
});

const text = msg.content.filter(b => b.type === “text”).map(b => b.text).join(””);
const parsed = parseJson(text);
parsed.day = dayNum;

state.days.push(parsed);
saveState(state);

appendLog(`💰 Portfolio: €${parsed.totalValue.toFixed(2)} (${parsed.pnlPercent >= 0 ? "+" : ""}${parsed.pnlPercent.toFixed(2)}%) | Cash: €${parsed.cash.toFixed(2)}`);
appendLog(`📰 ${parsed.marketAnalysis}`);
(parsed.trades || []).forEach(t =>
appendLog(`${t.action === "BUY" ? "🟢" : "🔴"} ${t.action} ${t.ticker}: ${t.shares}× @ $${t.price} = €${t.total} | ${t.reason}`)
);
appendLog(`🎯 ${parsed.strategy}`);

generateReadme(state.days, marketData, news);
}

main().catch(e => {
appendLog(`❌ ERROR: ${e.message}`);
process.exit(1);
});