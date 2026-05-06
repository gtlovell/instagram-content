import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { requireEnv, withRetry } from "./lib/retry.js";

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
    const res = await withRetry(`Read ${range}`, () =>
      sheets.spreadsheets.values.get({
        spreadsheetId: SHEETS_ID,
        range,
      })
    );
    return res.data.values || [];
  } catch {
    return [];
  }
}

async function ensureSheet(sheets, title) {
  const meta = await withRetry(`Sheets metadata for ${title}`, () =>
    sheets.spreadsheets.get({ spreadsheetId: SHEETS_ID })
  );
  const exists = meta.data.sheets.some((s) => s.properties.title === title);
  if (!exists) {
    await withRetry(`Create ${title} sheet`, () =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEETS_ID,
        requestBody: {
          requests: [{ addSheet: { properties: { title } } }],
        },
      })
    );
  }
}

async function clearAndWrite(sheets, range, values) {
  await withRetry(`Clear ${range}`, () =>
    sheets.spreadsheets.values.clear({
      spreadsheetId: SHEETS_ID,
      range,
    })
  );
  await withRetry(`Write ${range}`, () =>
    sheets.spreadsheets.values.update({
      spreadsheetId: SHEETS_ID,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    })
  );
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

  // Posts tab supports both the old six-column shape and the new multi-format shape.
  const postsRaw = await readSheetTab(sheets, "Posts!A1:K500");
  // Metrics tab: Fetched At, Post URL, Post URN, Topic, Hook,
  //              Impressions, Unique Impressions, Clicks,
  //              Likes, Comments, Reposts, Engagement Rate
  const metricsRaw = await readSheetTab(sheets, "Metrics!A1:M500");

  const posts = rowsToObjects(postsRaw);
  const metrics = rowsToObjects(metricsRaw);

  console.log(`  Posts tab: ${posts.length} rows`);
  console.log(`  Metrics tab: ${metrics.length} rows`);

  // Join map: Metrics keyed by post_url (most recent tracking date wins)
  const metricsMap = new Map();
  for (const m of metrics) {
    const url = (m.post_url || "").trim();
    if (url) {
      const existing = metricsMap.get(url);
      if (!existing || (m.fetched_at || "") > (existing.fetched_at || "")) {
        metricsMap.set(url, m);
      }
    }
  }

  const joined = posts
    .filter((p) => p.status === "posted")
    .map((p) => {
      const url = (p.post_url || "").trim();
      const m = (url && metricsMap.get(url)) || {};
      return { ...p, ...m };
    });

  console.log(`  Joined (posted with metrics): ${joined.length} rows`);

  // Also include metrics rows that have no matching Posts entry
  const joinedUrls = new Set(joined.map((j) => j.post_url).filter(Boolean));
  for (const [url, m] of metricsMap) {
    if (!joinedUrls.has(url)) {
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
    num(post.reposts) * 5 +
    num(post.comments) * 3 +
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
    formatScores: {},
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

    const contentType = p.content_type || "carousel";
    if (!patterns.formatScores[contentType]) {
      patterns.formatScores[contentType] = { totalScore: 0, count: 0, impressions: 0, clicks: 0 };
    }
    patterns.formatScores[contentType].totalScore += p.score;
    patterns.formatScores[contentType].count += 1;
    patterns.formatScores[contentType].impressions += num(p.impressions);
    patterns.formatScores[contentType].clicks += num(p.clicks);
  }

  // Compute averages
  for (const group of [patterns.topicScores, patterns.hookTypeScores, patterns.formatScores]) {
    for (const key of Object.keys(group)) {
      group[key].avgScore = Math.round(group[key].totalScore / group[key].count);
      if (group[key].impressions !== undefined) {
        group[key].avgImpressions = Math.round(group[key].impressions / group[key].count);
        group[key].avgClicks = Math.round(group[key].clicks / group[key].count);
      }
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
  if (hook.length > 0) return "statement";
  return "unknown";
}

// ── Step 3: Claude analysis ─────────────────────────────────────────────────
function buildAnalysisPrompt(analysis) {
  const { top5, bottom5, patterns, totalPosts } = analysis;

  const formatPost = (p) =>
    `  - URL: ${p.post_url || "n/a"}
    Type: ${p.content_type || "carousel"} | Topic: ${p.topic || "n/a"} | Hook: "${p.hook || "n/a"}"
    Score: ${p.score} | Impressions: ${p.impressions || 0} | Unique Impressions: ${p.unique_impressions || 0}
    Likes: ${p.likes || 0} | Comments: ${p.comments || 0} | Reposts: ${p.reposts || 0}
    Clicks: ${p.clicks || 0} | Engagement Rate: ${p.engagement_rate || 0}
    Date: ${p.date || p.fetched_at || "n/a"}`;

  const topicRanking = Object.entries(patterns.topicScores)
    .sort(([, a], [, b]) => b.avgScore - a.avgScore)
    .map(([topic, d]) => `  ${topic}: avg ${d.avgScore} (${d.count} posts)`)
    .join("\n");

  const hookRanking = Object.entries(patterns.hookTypeScores)
    .sort(([, a], [, b]) => b.avgScore - a.avgScore)
    .map(([type, d]) => `  ${type}: avg ${d.avgScore} (${d.count} posts)`)
    .join("\n");

  const formatRanking = Object.entries(patterns.formatScores)
    .sort(([, a], [, b]) => b.avgScore - a.avgScore)
    .map(([type, d]) => `  ${type}: avg score ${d.avgScore}, avg impressions ${d.avgImpressions}, avg clicks ${d.avgClicks} (${d.count} posts)`)
    .join("\n");

  return `Based on this LinkedIn performance data, update our content playbook for three content formats: carousel documents, text-only posts, and single-image posts. Identify the formats, hook formulas, topics, and content structures that drive the most reposts and comments. Still evaluate carousel slide count, but only inside carousel-specific recommendations.

PERFORMANCE DATA (${totalPosts} total posts analyzed):

TOP 5 POSTS (by weighted score: reposts*5 + comments*3 + likes):
${top5.map(formatPost).join("\n\n")}

BOTTOM 5 POSTS:
${bottom5.map(formatPost).join("\n\n")}

TOPIC PERFORMANCE (avg score):
${topicRanking}

HOOK TYPE PERFORMANCE (avg score):
${hookRanking}

CONTENT FORMAT PERFORMANCE:
${formatRanking}

SCORING FORMULA: score = (reposts × 5) + (comments × 3) + likes
Reposts are weighted highest because they signal algorithmic amplification and peer endorsement.
Comments are weighted heavily because they drive professional conversation and LinkedIn's algorithm.
Likes are counted but weighted least as they represent passive engagement.

PLATFORM CONTEXT: This is LinkedIn content targeting a B2B audience. Formats include carousel documents, text-only posts, and single-image posts. Audience consists of professionals, founders, and operators. Tone should be authoritative, data-driven, and actionable. CTAs drive app downloads, comments, saves, or newsletter signups.

Please respond with a JSON object in this exact structure:
{
  "generated_date": "YYYY-MM-DD",
  "total_posts_analyzed": <number>,
  "format_performance": [
    { "content_type": "carousel|post|image", "avg_score": <number>, "avg_impressions": <number>, "recommendation": "..." }
  ],
  "top_hook_formulas": [
    { "formula": "...", "why_it_works": "...", "example": "...", "avg_reposts": <number> }
  ],
  "carousel_recommendations": {
    "optimal_slide_count": { "recommended": <number>, "reasoning": "..." },
    "when_to_use": "..."
  },
  "top_topics": [
    { "topic": "...", "avg_score": <number>, "recommendation": "..." }
  ],
  "stop_doing": [
    { "pattern": "...", "reason": "...", "evidence": "..." }
  ],
  "next_content_ideas": [
    { "content_type": "carousel|post|image", "topic": "...", "hook": "...", "angle": "...", "why": "...", "asset_count": <number> }
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

  const response = await withRetry("Claude playbook generation", () =>
    anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    })
  );

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

  rows.push(["── FORMAT PERFORMANCE ──", ""]);
  for (const f of playbook.format_performance || []) {
    rows.push([
      f.content_type || "unknown",
      `Avg score: ${f.avg_score} | Avg impressions: ${f.avg_impressions} | ${f.recommendation}`,
    ]);
  }
  rows.push(["", ""]);

  rows.push(["── TOP HOOK FORMULAS ──", ""]);
  for (const h of playbook.top_hook_formulas || []) {
    rows.push([`Hook: ${h.formula}`, `Why: ${h.why_it_works} | Example: "${h.example}"`]);
  }
  rows.push(["", ""]);

  rows.push(["── CAROUSEL RECOMMENDATIONS ──", ""]);
  const carousel = playbook.carousel_recommendations || {};
  const sc = carousel.optimal_slide_count || playbook.optimal_slide_count || {};
  rows.push([`Recommended: ${sc.recommended || "N/A"} slides`, sc.reasoning || ""]);
  if (carousel.when_to_use) rows.push(["When to use", carousel.when_to_use]);
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

  rows.push(["── NEXT CONTENT IDEAS ──", ""]);
  const nextIdeas = playbook.next_content_ideas || playbook.next_carousel_ideas || [];
  for (const idea of nextIdeas) {
    rows.push([
      `${idea.content_type || "carousel"} | ${idea.topic}: "${idea.hook}"`,
      `Angle: ${idea.angle} | Why: ${idea.why} | Assets: ${idea.asset_count || idea.slide_count || "n/a"}`,
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
      `           Reposts: ${p.reposts || 0} | Comments: ${p.comments || 0} | Likes: ${p.likes || 0}`
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

  console.log("\n── FORMAT RANKING ─────────────────────────────────────");
  const formatsSorted = Object.entries(patterns.formatScores)
    .sort(([, a], [, b]) => b.avgScore - a.avgScore);
  for (const [type, data] of formatsSorted) {
    console.log(
      `  ${type.padEnd(12)} avg score: ${String(data.avgScore).padStart(5)} | avg impressions: ${String(data.avgImpressions).padStart(5)} (${data.count} posts)`
    );
  }

  console.log("\n── KEY STRATEGIC INSIGHTS ─────────────────────────────");
  for (const insight of playbook.strategic_insights || []) {
    console.log(`  • ${insight}`);
  }

  console.log("\n── NEXT CONTENT IDEAS ─────────────────────────────────");
  const nextIdeas = playbook.next_content_ideas || playbook.next_carousel_ideas || [];
  for (const idea of nextIdeas) {
    console.log(`  → "${idea.hook}"`);
    console.log(
      `    Type: ${idea.content_type || "carousel"} | Topic: ${idea.topic} | Assets: ${idea.asset_count || idea.slide_count || "n/a"} | ${idea.angle}`
    );
  }

  console.log("\n── CONTENT RULES ─────────────────────────────────────");
  for (const rule of playbook.content_rules || []) {
    console.log(`  ✓ ${rule.rule}`);
  }

  console.log("\n" + "═".repeat(60));
  console.log("  Playbook saved to: Sheets 'Playbook' tab + ./research/playbook.json");
  console.log("  generate.js will auto-read this playbook for future content.");
  console.log("═".repeat(60) + "\n");
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== CleanStreak LinkedIn Content Iteration Engine ===\n");

  requireEnv("ANTHROPIC_API_KEY", "iteration");
  requireEnv("SHEETS_ID", "iteration");

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
