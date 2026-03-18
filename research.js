import "dotenv/config";
import { ApifyClient } from "apify-client";
import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import { readFileSync, mkdirSync, writeFileSync } from "fs";

// ── Config ──────────────────────────────────────────────────────────────────
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SHEETS_ID = process.env.SHEETS_ID;
const CREDENTIALS_PATH = "./credentials/sheets-service-account.json";

const HASHTAGS = [
  "#ultraprocessedfood",
  "#upffree",
  "#cleanstreak",
  "#foodlabels",
  "#processedfoods",
];

const POSTS_PER_HASHTAG = 20;

// ── Apify: Scrape Instagram posts by hashtag ────────────────────────────────
async function scrapeInstagramPosts() {
  const client = new ApifyClient({ token: APIFY_TOKEN });

  console.log("Scraping Instagram posts for hashtags:", HASHTAGS.join(", "));

  const input = {
    hashtags: HASHTAGS,
    resultsLimit: POSTS_PER_HASHTAG,
    resultsType: "posts",
    searchType: "hashtag",
  };

  const run = await client.actor("apify/instagram-scraper").call(input);
  const { items } = await client.dataset(run.defaultDatasetId).listItems();

  console.log(`Scraped ${items.length} raw posts`);

  return items.map(normalizePost);
}

function normalizePost(item) {
  const caption = item.caption || "";
  const firstLine = caption.split("\n")[0].trim();
  const hashtagMatches = caption.match(/#[\w]+/g) || [];

  let postType = "single";
  if (item.type === "Video" || item.videoUrl) postType = "reel";
  else if (
    (item.images && item.images.length > 1) ||
    (item.childPosts && item.childPosts.length > 0) ||
    item.type === "Sidecar"
  )
    postType = "carousel";

  return {
    account: item.ownerUsername || item.ownerFullName || "unknown",
    caption,
    hook: firstLine,
    hashtags: hashtagMatches,
    likes: item.likesCount ?? item.likes ?? 0,
    comments: item.commentsCount ?? item.comments ?? 0,
    saves: item.savesCount ?? null,
    postType,
    url: item.url || item.shortCode ? `https://www.instagram.com/p/${item.shortCode}/` : "",
    timestamp: item.timestamp || item.takenAtTimestamp || null,
  };
}

// ── Claude: Analyze posts ───────────────────────────────────────────────────
async function analyzeWithClaude(posts) {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  console.log("Sending data to Claude for analysis...");

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `You are an Instagram content strategist specializing in health/wellness niches.

I run CleanStreak, a UPF (ultra-processed food) tracking app. Below are the top recent Instagram posts from hashtags in my niche: #ultraprocessedfood #upffree #cleanstreak #foodlabels #processedfoods.

Analyze these posts and return ONLY valid JSON (no markdown fences) with this exact structure:

{
  "hookFormulas": [
    { "formula": "...", "example": "...", "whyItWorks": "..." }
  ],
  "carouselStructures": [
    { "structure": "...", "slideBreakdown": "...", "example": "..." }
  ],
  "recurringCTAs": [
    { "cta": "...", "frequency": "...", "context": "..." }
  ],
  "emotionalTriggers": [
    { "trigger": "...", "howUsed": "...", "effectiveness": "..." }
  ],
  "contentGaps": [
    { "gap": "...", "opportunity": "...", "suggestedAngle": "..." }
  ],
  "summary": "..."
}

Provide exactly: top 5 hook formulas, top 3 carousel structures, all recurring CTAs you find, emotional triggers used, and content gaps/opportunities for CleanStreak.

Here are the posts:
${JSON.stringify(posts, null, 2)}`,
      },
    ],
  });

  const text = message.content[0].text;

  // Parse JSON from response (handle possible markdown fences)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Claude did not return valid JSON. Raw response:\n" + text);
  }

  const analysis = JSON.parse(jsonMatch[0]);
  console.log("Claude analysis complete.");
  return analysis;
}

// ── Google Sheets: Write data ───────────────────────────────────────────────
async function getGoogleSheetsClient() {
  const credentials = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8"));

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });
  return sheets;
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

async function writeResearchToSheets(sheets, posts) {
  await ensureSheet(sheets, "Research");

  const header = [
    "Account",
    "Hook",
    "Caption",
    "Hashtags",
    "Likes",
    "Comments",
    "Saves",
    "Post Type",
    "URL",
    "Timestamp",
  ];

  const rows = posts.map((p) => [
    p.account,
    p.hook,
    p.caption,
    p.hashtags.join(", "),
    p.likes,
    p.comments,
    p.saves ?? "N/A",
    p.postType,
    p.url,
    p.timestamp ? new Date(p.timestamp * 1000).toISOString() : "",
  ]);

  await clearAndWrite(sheets, "Research!A1", [header, ...rows]);
  console.log(`Wrote ${rows.length} posts to "Research" tab.`);
}

async function writePlaybookToSheets(sheets, analysis) {
  await ensureSheet(sheets, "Playbook");

  const rows = [
    ["CleanStreak Instagram Content Playbook"],
    ["Generated", new Date().toISOString()],
    [],
    ["=== TOP 5 HOOK FORMULAS ==="],
  ];

  for (const h of analysis.hookFormulas || []) {
    rows.push(["Formula", h.formula]);
    rows.push(["Example", h.example]);
    rows.push(["Why It Works", h.whyItWorks]);
    rows.push([]);
  }

  rows.push(["=== TOP 3 CAROUSEL STRUCTURES ==="]);
  for (const c of analysis.carouselStructures || []) {
    rows.push(["Structure", c.structure]);
    rows.push(["Slide Breakdown", c.slideBreakdown]);
    rows.push(["Example", c.example]);
    rows.push([]);
  }

  rows.push(["=== RECURRING CTAs ==="]);
  for (const cta of analysis.recurringCTAs || []) {
    rows.push(["CTA", cta.cta]);
    rows.push(["Frequency", cta.frequency]);
    rows.push(["Context", cta.context]);
    rows.push([]);
  }

  rows.push(["=== EMOTIONAL TRIGGERS ==="]);
  for (const t of analysis.emotionalTriggers || []) {
    rows.push(["Trigger", t.trigger]);
    rows.push(["How Used", t.howUsed]);
    rows.push(["Effectiveness", t.effectiveness]);
    rows.push([]);
  }

  rows.push(["=== CONTENT GAPS & OPPORTUNITIES ==="]);
  for (const g of analysis.contentGaps || []) {
    rows.push(["Gap", g.gap]);
    rows.push(["Opportunity", g.opportunity]);
    rows.push(["Suggested Angle", g.suggestedAngle]);
    rows.push([]);
  }

  rows.push([]);
  rows.push(["=== SUMMARY ==="]);
  rows.push([analysis.summary || ""]);

  await clearAndWrite(sheets, "Playbook!A1", rows);
  console.log('Wrote analysis to "Playbook" tab.');
}

// ── Local save ──────────────────────────────────────────────────────────────
function saveLocally(posts, analysis) {
  mkdirSync("research", { recursive: true });

  const output = {
    generatedAt: new Date().toISOString(),
    postCount: posts.length,
    posts,
    analysis,
  };

  writeFileSync("research/latest.json", JSON.stringify(output, null, 2));
  console.log("Saved to research/latest.json");
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== CleanStreak Instagram Research Agent ===\n");

  // 1. Scrape posts
  const posts = await scrapeInstagramPosts();

  // 2. Analyze with Claude
  const analysis = await analyzeWithClaude(posts);

  // 3. Write to Google Sheets
  try {
    const sheets = await getGoogleSheetsClient();
    await writeResearchToSheets(sheets, posts);
    await writePlaybookToSheets(sheets, analysis);
  } catch (err) {
    console.error("Google Sheets write failed:", err.message);
    console.log("Continuing with local save...");
  }

  // 4. Save locally
  saveLocally(posts, analysis);

  console.log("\nDone! Check your Google Sheet and research/latest.json");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
