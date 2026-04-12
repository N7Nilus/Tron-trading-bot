import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";

const DATA_DIR = "./data";
const STATE_FILE = path.join(DATA_DIR, "state.json");
const LOG_FILE = path.join(DATA_DIR, "log.md");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── helpers ───────────────────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { days: [] }; }
}

function saveState(s) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function appendLog(msg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const line = `- \`${new Date().toISOString()}\` ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
  console.log(msg);
}

function parseJson(text) {
  let parsed = null;
  try { parsed = JSON.parse(text.trim()); } catch {}
  if (!parsed) { try { parsed = JSON.parse(text.replace(/```json|```/gi, "").trim()); } catch {} }
  if (!parsed) {
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s !== -1 && e > s) try { parsed = JSON.parse(text.slice(s, e + 1)); } catch {}
  }
  if (!parsed) throw new Error(`No JSON found. Preview: ${text.slice(0, 200)}`);
  return parsed;
}

// ── prompt ────────────────────────────────────────────────────────────────────
const SYSTEM = `You are writing a fictional story about an AI character called ARIA inside a stock market simulation game. Purely fictional creative writing — no real money, no real trades, no real financial advice.

ARIA manages a fictional €500 portfolio trying to reach €5000 (10x). Be bold and dramatic.

Respond ONLY with this JSON (no markdown, no backticks, no other text):
{
  "day": <number>,
  "date": "<DD.MM.YYYY>",
  "portfolio": [{"ticker":"X","name":"Name","shares":<n>,"buyPrice":<n>,"currentPrice":<n>,"value":<n>}],
  "cash": <number>,
  "totalValue": <number>,
  "pnl": <number>,
  "pnlPercent": <number>,
  "trades": [{"action":"BUY/SELL","ticker":"X","shares":<n>,"price":<n>,"total":<n>,"reason":"<story reasoning with fictional price target>"}],
  "marketAnalysis": "<2-3 sentences of fictional market narrative>",
  "strategy": "<ARIA plan>",
  "mood": "bullish/bearish/neutral"
}`;

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const state = loadState();
  const dayNum = state.days.length + 1;

  if (dayNum > 30) {
    appendLog("✅ Challenge complete — 30/30 days done");
    process.exit(0);
  }

  appendLog(`━━━ DAY ${dayNum} START ━━━`);

  const history = state.days.slice(-3).map(d =>
    JSON.stringify({ day: d.day, totalValue: d.totalValue, portfolio: d.portfolio, trades: d.trades, strategy: d.strategy })
  ).join("\n");

  const userMsg = dayNum === 1
    ? `Day 1. April 9, 2025. Cash: €500, no positions. Goal: €500→€5000. Make first aggressive fictional trades.`
    : `History (last 3 days):\n${history}\n\nNow Day ${dayNum}. Continue the story aggressively toward €5000. Simulate realistic price changes.`;

  const msg = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1200,
    system: SYSTEM,
    messages: [{ role: "user", content: userMsg }],
  });

  const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
  const parsed = parseJson(text);
  parsed.day = dayNum;

  state.days.push(parsed);
  saveState(state);

  // Write human-readable summary
  appendLog(`💰 Portfolio: €${parsed.totalValue.toFixed(2)} (${parsed.pnlPercent >= 0 ? "+" : ""}${parsed.pnlPercent.toFixed(2)}%) | Cash: €${parsed.cash.toFixed(2)}`);
  appendLog(`📰 ${parsed.marketAnalysis}`);
  (parsed.trades || []).forEach(t =>
    appendLog(`${t.action === "BUY" ? "🟢 BUY" : "🔴 SELL"} ${t.ticker}: ${t.shares}x @ €${t.price} = €${t.total} | ${t.reason}`)
  );
  appendLog(`🎯 ${parsed.strategy}`);

  // Generate README summary
  generateReadme(state.days);
}

function generateReadme(days) {
  const last = days[days.length - 1];
  if (!last) return;
  const progress = Math.min(((last.totalValue - 500) / (5000 - 500)) * 100, 100);
  const bar = "█".repeat(Math.round(progress / 5)) + "░".repeat(20 - Math.round(progress / 5));

  let md = `# 🤖 ARIA Trading Bot — €500 → €5.000 Challenge\n\n`;
  md += `> Fiktive Simulation | Letztes Update: ${new Date().toLocaleString("de-DE")}\n\n`;
  md += `## 📊 Status: Tag ${days.length}/30\n\n`;
  md += `| | |\n|---|---|\n`;
  md += `| **Portfoliowert** | €${last.totalValue.toFixed(2)} |\n`;
  md += `| **P&L** | ${last.pnlPercent >= 0 ? "+" : ""}${last.pnlPercent.toFixed(2)}% |\n`;
  md += `| **Cash** | €${last.cash.toFixed(2)} |\n`;
  md += `| **Mood** | ${{ bullish: "🐂 Bullish", bearish: "🐻 Bearish", neutral: "😐 Neutral" }[last.mood] || last.mood} |\n\n`;
  md += `## 🎯 Fortschritt\n\`\`\`\n€500 [${bar}] €5.000\n       ${progress.toFixed(1)}% erreicht\n\`\`\`\n\n`;
  md += `## 📰 Heute (Tag ${last.day})\n${last.marketAnalysis}\n\n`;

  if (last.portfolio?.length) {
    md += `## 💼 Positionen\n| Ticker | Stk | Einstieg | Aktuell | Wert | P&L |\n|---|---|---|---|---|---|\n`;
    last.portfolio.forEach(p => {
      const pct = ((p.currentPrice - p.buyPrice) / p.buyPrice) * 100;
      md += `| [${p.ticker}](https://finance.yahoo.com/quote/${p.ticker}) | ${p.shares} | €${p.buyPrice} | €${p.currentPrice} | €${p.value.toFixed(2)} | ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% |\n`;
    });
    md += "\n";
  }

  if (last.trades?.length) {
    md += `## 💱 Trades heute\n`;
    last.trades.forEach(t => {
      md += `- **${t.action}** [${t.ticker}](https://finance.yahoo.com/quote/${t.ticker}) — ${t.shares}x @ €${t.price} = €${t.total}\n  > ${t.reason}\n`;
    });
    md += "\n";
  }

  md += `## 📈 Verlauf\n| Tag | Datum | Wert | P&L% |\n|---|---|---|---|\n`;
  days.forEach(d => {
    md += `| ${d.day} | ${d.date} | €${d.totalValue.toFixed(2)} | ${d.pnlPercent >= 0 ? "+" : ""}${d.pnlPercent.toFixed(2)}% |\n`;
  });

  fs.writeFileSync("README.md", md);
}

main().catch(e => {
  appendLog(`❌ ERROR: ${e.message}`);
  process.exit(1);
});
