import "dotenv/config";
import { ApifyClient } from "apify-client";
import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { requireEnv, withRetry } from "./lib/retry.js";

// ── Config ──────────────────────────────────────────────────────────────────
const APIFY_TOKEN       = process.env.APIFY_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SHEETS_ID         = process.env.SHEETS_ID;
const CREDENTIALS_PATH  = process.env.GOOGLE_CREDENTIALS_PATH || "./credentials/sheets-service-account.json";

// Keywords used to search LinkedIn for relevant posts
const SEARCH_KEYWORDS = [
  "ultra processed food",
  "food labels ingredients",
  "UPF health",
  "processed food hidden sugar",
  "clean eating habits",
  "food additives",
  "ingredient list reading",
  "nutrition label decoded",
];

const POSTS_PER_KEYWORD = 15;

// ── Apify: Scrape LinkedIn posts by keyword ─────────────────────────────────
async function scrapeLinkedInPosts() {
  const client = new ApifyClient({ token: APIFY_TOKEN });

  console.log("Scraping LinkedIn posts for keywords:", SEARCH_KEYWORDS.join(", "));

  // Apify actor: curious_coder/linkedin-post-search
  // Searches LinkedIn posts by keyword and returns post data
  const input = {
    keywords: SEARCH_KEYWORDS,
    maxResults: POSTS_PER_KEYWORD,
    proxy: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
  };

  const run = await withRetry("Apify LinkedIn search", () =>
    client.actor("curious_coder/linkedin-post-search").call(input, {
      timeoutSecs: 300,
    })
  );
  const { items } = await withRetry("Apify dataset read", () =>
    client.dataset(run.defaultDatasetId).listItems()
  );

  console.log(`Scraped ${items.length} raw LinkedIn posts`);

  return items.map(normalizePost).filter(Boolean);
}

function normalizePost(item) {
  try {
    const text = item.text || item.commentary || item.content || "";
    const firstLine = text.split("\n")[0].trim();

    return {
      authorName:   item.authorName || item.author?.name || "Unknown",
      authorTitle:  item.authorTitle || item.author?.headline || "",
      authorFollowers: item.authorFollowers || item.author?.followersCount || 0,
      text:         text,
      firstLine:    firstLine,
      likes:        item.likesCount       || item.numLikes       || 0,
      comments:     item.commentsCount    || item.numComments    || 0,
      reposts:      item.repostsCount     || item.numReposts     || 0,
      postType:     item.type             || "text",
      url:          item.url              || item.postUrl        || "",
      postedAt:     item.postedAt         || item.createdAt      || "",
    };
  } catch {
    return null;
  }
}

// ── Filter: engagement threshold ────────────────────────────────────────────
function filterEngaged(posts) {
  const scored = posts.map((p) => ({
    ...p,
    engagementScore: p.likes + p.comments * 3 + p.reposts * 5,
  }));

  scored.sort((a, b) => b.engagementScore - a.engagementScore);

  // Deduplicate by URL
  const seen = new Set();
  const unique = scored.filter((p) => {
    if (!p.url || seen.has(p.url)) return false;
    seen.add(p.url);
    return true;
  });

  const top = unique.slice(0, 40);
  console.log(`Filtered to ${top.length} unique engaged posts`);
  return top;
}

// ── Google Sheets ────────────────────────────────────────────────────────────
async function getSheetsClient() {
  const credentials = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8"));
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
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
        requestBody: { requests: [{ addSheet: { properties: { title } } }] },
      })
    );
  }
}

async function appendToResearchTab(sheets, posts) {
  console.log('Appending to "Research" tab in Sheets...');

  await ensureSheet(sheets, "Research");

  const HEADER = [
    "Scraped At", "Author", "Title", "Followers",
    "Likes", "Comments", "Reposts", "Engagement Score",
    "Post Type", "First Line", "URL",
  ];

  const existing = await withRetry("Read Research header", () =>
    sheets.spreadsheets.values.get({
      spreadsheetId: SHEETS_ID,
      range: "Research!A1:A1",
    })
  ).catch(() => ({ data: { values: [] } }));

  if (!existing.data.values?.length) {
    await withRetry("Write Research header", () =>
      sheets.spreadsheets.values.update({
        spreadsheetId: SHEETS_ID,
        range: "Research!A1",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [HEADER] },
      })
    );
  }

  const now = new Date().toISOString().slice(0, 10);
  const rows = posts.map((p) => [
    now,
    p.authorName,
    p.authorTitle,
    p.authorFollowers,
    p.likes,
    p.comments,
    p.reposts,
    p.engagementScore,
    p.postType,
    p.firstLine.slice(0, 200),
    p.url,
  ]);

  await withRetry("Append Research rows", () =>
    sheets.spreadsheets.values.append({
      spreadsheetId: SHEETS_ID,
      range: "Research!A:K",
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: rows },
    })
  );

  console.log(`  Appended ${rows.length} rows to Research tab.`);
}

// ── Claude: Analyze what's working ─────────────────────────────────────────
async function analyzeWithClaude(posts) {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  console.log("Analyzing top posts with Claude...");

  const postSummaries = posts.slice(0, 20).map((p, i) =>
    `#${i + 1} [score ${p.engagementScore}] @${p.authorName} (${p.authorFollowers} followers)
Type: ${p.postType}
First line: "${p.firstLine}"
Full text (first 400 chars): ${p.text.slice(0, 400)}
Likes: ${p.likes} | Comments: ${p.comments} | Reposts: ${p.reposts}
---`
  ).join("\n");

  const message = await withRetry("Claude research analysis", () =>
    anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: `You are a LinkedIn content strategist analyzing high-performing posts about ultra-processed food, nutrition labels, and clean eating for a health app (CleanStreak — a UPF barcode scanner with streak tracking).

TARGET AUDIENCE ON LINKEDIN: Health-conscious professionals aged 28-50, corporate wellness advocates, nutritionists, dietitians, fitness coaches, and educated parents. They engage with evidence-based content, data-backed claims, and actionable professional advice. LinkedIn tone is more authoritative than Instagram but still conversational.

Here are the top ${posts.slice(0, 20).length} performing LinkedIn posts in this niche:

${postSummaries}

Analyze what is winning and return ONLY valid JSON (no markdown fences):

{
  "topInsights": [
    "Insight about what hook formats or content structures get the most engagement on LinkedIn"
  ],
  "winningHookFormulas": [
    "Hook formula with example — describe the pattern"
  ],
  "contentPatterns": [
    "Structural pattern that appears in top posts"
  ],
  "audiencePainPoints": [
    "Pain point or fear that top posts are tapping into on LinkedIn"
  ],
  "toneObservations": "1-2 sentences about the writing tone that performs well",
  "linkedInSpecificNotes": "Observations specific to LinkedIn format — document posts vs text, length, line breaks, hashtags, etc.",
  "recommendedTopics": [
    "Topic idea for CleanStreak LinkedIn content based on what's performing, with suggested format if obvious"
  ],
  "postCount": ${posts.slice(0, 20).length}
}`,
        },
      ],
    })
  );

  const text = message.content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("Claude returned non-JSON response");
  }
}

// ── Save research locally ────────────────────────────────────────────────────
function saveResearchLocally(posts, analysis) {
  mkdirSync("./research", { recursive: true });
  const output = {
    scrapedAt:  new Date().toISOString(),
    platform:   "linkedin",
    postCount:  posts.length,
    posts,
    analysis,
  };
  writeFileSync("./research/latest.json", JSON.stringify(output, null, 2));
  console.log("  Saved to ./research/latest.json");
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== CleanStreak LinkedIn Research ===\n");
  requireEnv("APIFY_TOKEN", "research");
  requireEnv("ANTHROPIC_API_KEY", "research");

  // 1. Scrape LinkedIn posts
  const raw = await scrapeLinkedInPosts();
  const posts = filterEngaged(raw);

  // 2. Analyze with Claude
  const analysis = await analyzeWithClaude(posts);
  console.log("\nTop insights:");
  analysis.topInsights?.forEach((i, n) => console.log(`  ${n + 1}. ${i}`));

  // 3. Save locally
  saveResearchLocally(posts, analysis);

  // 4. Append to Google Sheets
  let sheets;
  try {
    sheets = await getSheetsClient();
    await appendToResearchTab(sheets, posts);
  } catch (err) {
    console.error("Google Sheets unavailable:", err.message);
    console.log("Research saved locally only.");
  }

  console.log("\nResearch complete.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
