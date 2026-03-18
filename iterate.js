import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";

// ── Config ──────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SHEETS_ID = process.env.SHEETS_ID;
const CREDENTIALS_PATH =
  process.env.GOOGLE_CREDENTIALS_PATH ||
  "./credentials/sheets-service-account.json";

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── Google Sheets ───────────────────────────────────────────────────────────
async function getGoogleSheetsClient() {
  const credentials = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8"));
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function readSheetTab(sheets, range) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEETS_ID,
      range,
    });
    return res.data.values || [];
  } catch {
    return [];
  }
}

async function ensureSheet(sheets, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEETS_ID });
  const exists = meta.data.sheets.some((s) => s.properties.title === title);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEETS_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title } } }],
      },
    });
  }
}

async function clearAndWrite(sheets, range, values) {
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEETS_ID,
    range,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEETS_ID,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
}

// ── Step 1: Load and join data ──────────────────────────────────────────────
function rowsToObjects(rows) {
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => (h || "").trim().toLowerCase().replace(/\s+/g, "_"));
  return rows.slice(1).map((row) => {
    const obj = {};
    header.forEach((key, i) => {
      obj[key] = (row[i] || "").trim();
    });
    return obj;
  });
}

async function loadAllData(sheets) {
  console.log("Loading data from Google Sheets...");

  const postsRaw = await readSheetTab(sheets, "Posts!A1:F500");
  const metricsRaw = await readSheetTab(sheets, "Metrics!A1:N500");

  const posts = rowsToObjects(postsRaw);
  const metrics = rowsToObjects(metricsRaw);

  console.log(`  Posts tab: ${posts.length} rows`);
  console.log(`  Metrics tab: ${metrics.length} rows`);

  // Join: for each post, attach its most recent metrics row
  const metricsMap = new Map();
  for (const m of metrics) {
    const url = m.post_url || "";
    if (!url) continue;
    const existing = metricsMap.get(url);
    // Keep the most recent tracking date
    if (!existing || (m.date_tracked || "") > (existing.date_tracked || "")) {
      metricsMap.set(url, m);
    }
  }

  const joined = posts
    .filter((p) => p.post_url && p.status === "posted")
    .map((p) => {
      const m = metricsMap.get(p.post_url) || {};
      return { ...p, ...m };
    });

  console.log(`  Joined (posted with metrics): ${joined.length} rows`);

  // Also include metrics rows that might not have a Posts match
  for (const [url, m] of metricsMap) {
    if (!joined.some((j) => j.post_url === url)) {
      joined.push(m);
    }
  }

  return { posts, metrics, joined, allMetrics: metrics };
}

// ── Step 2: Score and rank ──────────────────────────────────────────────────
function num(val) {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

function scorePost(post) {
  return (
    num(post.saves || post.saved) * 3 +
    num(post.shares) * 2 +
    num(post.profile_visits) * 2 +
    num(post.likes)
  );
}

function analyzePerformance(joined) {
  console.log("\nCalculating performance scores...\n");

  const scored = joined
    .map((p) => ({
      ...p,
      score: scorePost(p),
    }))
    .sort((a, b) => b.score - a.score);

  const top5 = scored.slice(0, 5);
  const bottom5 = scored.slice(-5).reverse();

  // Pattern analysis
  const patterns = {
    topicScores: {},
    hookTypeScores: {},
    mediaTypeScores: {},
  };

  for (const p of scored) {
    // Topic aggregation
    const topic = p.topic || "unknown";
    if (!patterns.topicScores[topic]) {
      patterns.topicScores[topic] = { totalScore: 0, count: 0, posts: [] };
    }
    patterns.topicScores[topic].totalScore += p.score;
    patterns.topicScores[topic].count += 1;
    patterns.topicScores[topic].posts.push(p.post_url);

    // Hook type analysis (first few words of the hook column)
    const hook = p.hook || "";
    const hookType = classifyHook(hook);
    if (!patterns.hookTypeScores[hookType]) {
      patterns.hookTypeScores[hookType] = { totalScore: 0, count: 0 };
    }
    patterns.hookTypeScores[hookType].totalScore += p.score;
    patterns.hookTypeScores[hookType].count += 1;

    // Media type
    const mediaType = p.media_type || "unknown";
    if (!patterns.mediaTypeScores[mediaType]) {
      patterns.mediaTypeScores[mediaType] = { totalScore: 0, count: 0 };
    }
    patterns.mediaTypeScores[mediaType].totalScore += p.score;
    patterns.mediaTypeScores[mediaType].count += 1;
  }

  // Compute averages
  for (const group of [patterns.topicScores, patterns.hookTypeScores, patterns.mediaTypeScores]) {
    for (const key of Object.keys(group)) {
      group[key].avgScore = Math.round(group[key].totalScore / group[key].count);
    }
  }

  return { scored, top5, bottom5, patterns, totalPosts: scored.length };
}

function classifyHook(hook) {
  const lower = hook.toLowerCase();
  if (/^\d+\s/.test(lower) || /^top\s/i.test(lower)) return "listicle";
  if (/\?/.test(lower)) return "question";
  if (/stop|don't|never|avoid|mistake/i.test(lower)) return "negative_frame";
  if (/how to|how i|step/i.test(lower)) return "how_to";
  if (/secret|hidden|nobody|most people/i.test(lower)) return "curiosity_gap";
  if (/you need|you should|you're/i.test(lower)) return "direct_address";
  if (/myth|truth|actually|reality/i.test(lower)) return "myth_buster";
  if (/save this|bookmark/i.test(lower)) return "save_bait";
  if (hook.length > 0) return "statement";
  return "unknown";
}

// ── Step 3: Claude analysis ─────────────────────────────────────────────────
function buildAnalysisPrompt(analysis) {
  const { top5, bottom5, patterns, totalPosts } = analysis;

  const formatPost = (p) =>
    `  - URL: ${p.post_url || "n/a"}
    Topic: ${p.topic || "n/a"} | Hook: "${p.hook || "n/a"}"
    Score: ${p.score} | Impressions: ${p.impressions || 0} | Reach: ${p.reach || 0}
    Likes: ${p.likes || 0} | Saves: ${p.saves || p.saved || 0} | Shares: ${p.shares || 0}
    Profile Visits: ${p.profile_visits || 0} | Follows: ${p.follows || 0}
    Media Type: ${p.media_type || "n/a"} | Date: ${p.date_posted || "n/a"}`;

  const topicRanking = Object.entries(patterns.topicScores)
    .sort(([, a], [, b]) => b.avgScore - a.avgScore)
    .map(([topic, d]) => `  ${topic}: avg ${d.avgScore} (${d.count} posts)`)
    .join("\n");

  const hookRanking = Object.entries(patterns.hookTypeScores)
    .sort(([, a], [, b]) => b.avgScore - a.avgScore)
    .map(([type, d]) => `  ${type}: avg ${d.avgScore} (${d.count} posts)`)
    .join("\n");

  const mediaRanking = Object.entries(patterns.mediaTypeScores)
    .sort(([, a], [, b]) => b.avgScore - a.avgScore)
    .map(([type, d]) => `  ${type}: avg ${d.avgScore} (${d.count} posts)`)
    .join("\n");

  return `Based on this performance data, update our content playbook. Identify: the 3 hook formulas that drive the most saves, the optimal slide count, which topics resonate most, what to stop doing, and 5 specific carousel ideas to create next based on gaps and winners.

PERFORMANCE DATA (${totalPosts} total posts analyzed):

TOP 5 POSTS (by weighted score: saves*3 + shares*2 + profile_visits*2 + likes):
${top5.map(formatPost).join("\n\n")}

BOTTOM 5 POSTS:
${bottom5.map(formatPost).join("\n\n")}

TOPIC PERFORMANCE (avg score):
${topicRanking}

HOOK TYPE PERFORMANCE (avg score):
${hookRanking}

MEDIA TYPE PERFORMANCE (avg score):
${mediaRanking}

SCORING FORMULA: score = (saves × 3) + (shares × 2) + (profile_visits × 2) + likes
Higher saves/shares are weighted more because they signal deeper intent and algorithmic reach.

Please respond with a JSON object in this exact structure:
{
  "generated_date": "YYYY-MM-DD",
  "total_posts_analyzed": <number>,
  "top_hook_formulas": [
    { "formula": "...", "why_it_works": "...", "example": "...", "avg_saves": <number> }
  ],
  "optimal_slide_count": { "recommended": <number>, "reasoning": "..." },
  "top_topics": [
    { "topic": "...", "avg_score": <number>, "recommendation": "..." }
  ],
  "stop_doing": [
    { "pattern": "...", "reason": "...", "evidence": "..." }
  ],
  "next_carousel_ideas": [
    { "topic": "...", "hook": "...", "angle": "...", "why": "...", "slide_count": <number> }
  ],
  "strategic_insights": [
    "..."
  ],
  "content_rules": [
    { "rule": "...", "based_on": "..." }
  ]
}

Return ONLY the JSON object, no markdown fences or other text.`;
}

async function getClaudePlaybook(analysis) {
  console.log("Sending analysis to Claude for playbook generation...\n");

  const prompt = buildAnalysisPrompt(analysis);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const text = response.content[0].text.trim();

  // Parse JSON from response (handle possible markdown fences)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Claude did not return valid JSON. Response:\n" + text.slice(0, 500));
  }

  return JSON.parse(jsonMatch[0]);
}

// ── Step 4: Write outputs ───────────────────────────────────────────────────
function playbookToSheetRows(playbook) {
  const rows = [["Section", "Content"]];

  rows.push(["Generated", playbook.generated_date || new Date().toISOString().slice(0, 10)]);
  rows.push(["Posts Analyzed", String(playbook.total_posts_analyzed || 0)]);
  rows.push(["", ""]);

  rows.push(["── TOP HOOK FORMULAS ──", ""]);
  for (const h of playbook.top_hook_formulas || []) {
    rows.push([`Hook: ${h.formula}`, `Why: ${h.why_it_works} | Example: "${h.example}"`]);
  }
  rows.push(["", ""]);

  rows.push(["── OPTIMAL SLIDE COUNT ──", ""]);
  const sc = playbook.optimal_slide_count || {};
  rows.push([`Recommended: ${sc.recommended || "N/A"} slides`, sc.reasoning || ""]);
  rows.push(["", ""]);

  rows.push(["── TOP TOPICS ──", ""]);
  for (const t of playbook.top_topics || []) {
    rows.push([t.topic, `Avg score: ${t.avg_score} | ${t.recommendation}`]);
  }
  rows.push(["", ""]);

  rows.push(["── STOP DOING ──", ""]);
  for (const s of playbook.stop_doing || []) {
    rows.push([s.pattern, `${s.reason} | Evidence: ${s.evidence}`]);
  }
  rows.push(["", ""]);

  rows.push(["── NEXT CAROUSEL IDEAS ──", ""]);
  for (const idea of playbook.next_carousel_ideas || []) {
    rows.push([
      `${idea.topic}: "${idea.hook}"`,
      `Angle: ${idea.angle} | Why: ${idea.why} | Slides: ${idea.slide_count}`,
    ]);
  }
  rows.push(["", ""]);

  rows.push(["── STRATEGIC INSIGHTS ──", ""]);
  for (const insight of playbook.strategic_insights || []) {
    rows.push(["Insight", insight]);
  }
  rows.push(["", ""]);

  rows.push(["── CONTENT RULES ──", ""]);
  for (const rule of playbook.content_rules || []) {
    rows.push([rule.rule, `Based on: ${rule.based_on}`]);
  }

  return rows;
}

async function writeOutputs(sheets, playbook) {
  // 1. Write to Sheets Playbook tab
  console.log("Writing playbook to Google Sheets...");
  await ensureSheet(sheets, "Playbook");
  const sheetRows = playbookToSheetRows(playbook);
  await clearAndWrite(sheets, "Playbook!A1", sheetRows);
  console.log(`  Playbook tab updated (${sheetRows.length} rows)`);

  // 2. Write local JSON
  if (!existsSync("./research")) {
    mkdirSync("./research", { recursive: true });
  }
  writeFileSync("./research/playbook.json", JSON.stringify(playbook, null, 2));
  console.log("  Written to ./research/playbook.json");
}

// ── Step 5: Console report ──────────────────────────────────────────────────
function printReport(analysis, playbook) {
  const { top5, bottom5, patterns, totalPosts } = analysis;

  console.log("\n" + "═".repeat(60));
  console.log("  CONTENT ITERATION REPORT");
  console.log("═".repeat(60));
  console.log(`\n  Posts analyzed: ${totalPosts}`);
  console.log(`  Report date: ${new Date().toISOString().slice(0, 10)}`);

  console.log("\n── TOP 5 PERFORMERS ──────────────────────────────────");
  for (const p of top5) {
    const hook = (p.hook || "").slice(0, 50);
    console.log(
      `  Score ${String(p.score).padStart(5)} | ${(p.topic || "?").padEnd(20)} | "${hook}"`
    );
    console.log(
      `           Saves: ${p.saves || p.saved || 0} | Shares: ${p.shares || 0} | Likes: ${p.likes || 0}`
    );
  }

  console.log("\n── BOTTOM 5 PERFORMERS ───────────────────────────────");
  for (const p of bottom5) {
    const hook = (p.hook || "").slice(0, 50);
    console.log(
      `  Score ${String(p.score).padStart(5)} | ${(p.topic || "?").padEnd(20)} | "${hook}"`
    );
  }

  console.log("\n── TOPIC RANKING ─────────────────────────────────────");
  const topicsSorted = Object.entries(patterns.topicScores)
    .sort(([, a], [, b]) => b.avgScore - a.avgScore);
  for (const [topic, data] of topicsSorted) {
    console.log(`  ${topic.padEnd(25)} avg: ${String(data.avgScore).padStart(5)} (${data.count} posts)`);
  }

  console.log("\n── HOOK TYPE RANKING ──────────────────────────────────");
  const hooksSorted = Object.entries(patterns.hookTypeScores)
    .sort(([, a], [, b]) => b.avgScore - a.avgScore);
  for (const [type, data] of hooksSorted) {
    console.log(`  ${type.padEnd(20)} avg: ${String(data.avgScore).padStart(5)} (${data.count} posts)`);
  }

  console.log("\n── KEY STRATEGIC INSIGHTS ─────────────────────────────");
  for (const insight of playbook.strategic_insights || []) {
    console.log(`  • ${insight}`);
  }

  console.log("\n── NEXT 5 CAROUSEL IDEAS ──────────────────────────────");
  for (const idea of playbook.next_carousel_ideas || []) {
    console.log(`  → "${idea.hook}"`);
    console.log(`    Topic: ${idea.topic} | ${idea.slide_count} slides | ${idea.angle}`);
  }

  console.log("\n── CONTENT RULES ─────────────────────────────────────");
  for (const rule of playbook.content_rules || []) {
    console.log(`  ✓ ${rule.rule}`);
  }

  console.log("\n" + "═".repeat(60));
  console.log("  Playbook saved to: Sheets 'Playbook' tab + ./research/playbook.json");
  console.log("  generate.js will auto-read this playbook for future carousels.");
  console.log("═".repeat(60) + "\n");
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== CleanStreak Content Iteration Engine ===\n");

  if (!ANTHROPIC_API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY env var.");
    process.exit(1);
  }

  // 1. Load data
  const sheets = await getGoogleSheetsClient();
  const { joined } = await loadAllData(sheets);

  if (joined.length === 0) {
    console.log(
      "\nNo posted entries with metrics found. Run track.js first to collect performance data."
    );
    process.exit(0);
  }

  // 2. Score and analyze
  const analysis = analyzePerformance(joined);

  // 3. Get Claude playbook
  const playbook = await getClaudePlaybook(analysis);

  // 4. Write outputs
  await writeOutputs(sheets, playbook);

  // 5. Print report
  printReport(analysis, playbook);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
