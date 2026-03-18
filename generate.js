import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import puppeteer from "puppeteer";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

// ── Config ──────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SHEETS_ID = process.env.SHEETS_ID;
const CREDENTIALS_PATH =
  process.env.GOOGLE_CREDENTIALS_PATH ||
  "./credentials/sheets-service-account.json";

const topic = process.argv[2];
if (!topic) {
  console.error("Usage: node generate.js \"your topic here\"");
  process.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ── Google Sheets client ────────────────────────────────────────────────────
async function getSheetsClient() {
  const credentials = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8"));
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
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

// ── Step 1: Load research context ───────────────────────────────────────────
async function loadResearchContext(sheets) {
  console.log("Loading research context...");

  // Local latest.json
  let localResearch = null;
  const localPath = "./research/latest.json";
  if (existsSync(localPath)) {
    localResearch = JSON.parse(readFileSync(localPath, "utf8"));
    console.log(
      `  Loaded local research: ${localResearch.postCount} posts + analysis`
    );
  } else {
    console.log("  No local research/latest.json found — skipping.");
  }

  // Playbook tab from Sheets
  const playbookRows = await readSheetTab(sheets, "Playbook!A1:B200");
  console.log(`  Loaded Playbook tab: ${playbookRows.length} rows`);

  return { localResearch, playbookRows };
}

// ── Step 2: Load top 3 performing posts from Metrics tab ────────────────────
async function loadTopPerformingPosts(sheets) {
  console.log("Loading top performing posts from Metrics tab...");

  const rows = await readSheetTab(sheets, "Metrics!A1:Z500");
  if (rows.length < 2) {
    console.log("  Metrics tab empty or missing — skipping.");
    return [];
  }

  const header = rows[0].map((h) => h.toLowerCase().trim());
  const dataRows = rows.slice(1);

  // Find engagement-related columns
  const likesIdx = header.findIndex((h) => h.includes("like"));
  const commentsIdx = header.findIndex((h) => h.includes("comment"));
  const savesIdx = header.findIndex((h) => h.includes("save"));
  const hookIdx = header.findIndex(
    (h) => h.includes("hook") || h.includes("caption") || h.includes("title")
  );

  const scored = dataRows.map((row, i) => {
    const likes = parseInt(row[likesIdx] || "0", 10) || 0;
    const comments = parseInt(row[commentsIdx] || "0", 10) || 0;
    const saves = parseInt(row[savesIdx] || "0", 10) || 0;
    // Weighted engagement score: saves 3x, comments 2x, likes 1x
    const score = likes + comments * 2 + saves * 3;
    return {
      index: i,
      score,
      hook: hookIdx >= 0 ? row[hookIdx] || "" : "",
      raw: Object.fromEntries(header.map((h, j) => [h, row[j] || ""])),
    };
  });

  scored.sort((a, b) => b.score - a.score);
  const top3 = scored.slice(0, 3);

  console.log(`  Found top 3 posts (scores: ${top3.map((p) => p.score).join(", ")})`);
  return top3;
}

// ── Step 3: Generate carousel with Claude ───────────────────────────────────
async function generateCarouselContent(topic, research, playbook, topPosts) {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  console.log("Generating carousel content with Claude...");

  const playbookText = playbook
    .map((row) => row.join(" | "))
    .join("\n");

  const topPostsText = topPosts.length
    ? topPosts
        .map(
          (p, i) =>
            `#${i + 1} (score ${p.score}): Hook: "${p.hook}" | ${JSON.stringify(p.raw)}`
        )
        .join("\n")
    : "No past metrics data available.";

  const researchAnalysis = research?.analysis
    ? JSON.stringify(research.analysis, null, 2)
    : "No research analysis available.";

  const researchPosts = research?.posts
    ? `Top performing scraped posts:\n${research.posts
        .sort((a, b) => (b.likes + b.comments * 2) - (a.likes + a.comments * 2))
        .slice(0, 10)
        .map((p) => `- @${p.account}: "${p.hook}" (${p.likes} likes, ${p.comments} comments, ${p.postType})`)
        .join("\n")}`
    : "";

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `You are an Instagram carousel content creator for CleanStreak, a UPF (ultra-processed food) tracking app with a barcode scanner and streak mechanic.

Target audience: health-conscious people aged 28-45 who are suspicious of processed food labels.

TOPIC FOR THIS CAROUSEL: "${topic}"

Here is the research context from recent high-performing posts in our niche:

=== RESEARCH ANALYSIS (what hooks/structures are winning) ===
${researchAnalysis}

=== TOP SCRAPED POSTS FOR REFERENCE ===
${researchPosts}

=== PLAYBOOK (proven formulas from our research) ===
${playbookText}

=== OUR TOP 3 PAST PERFORMING POSTS ===
${topPostsText}

Generate a 7-slide Instagram carousel. Return ONLY valid JSON (no markdown fences) as an array of objects:

[
  {
    "slideNumber": 1,
    "headline": "...",
    "body": "...",
    "visualNote": "..."
  }
]

Rules:
- Slide 1: HOOK slide. Use a proven hook formula from the research. Bold, provocative, makes people stop scrolling. The headline alone should compel a swipe.
- Slides 2-6: One insight per slide. Headline must be punchy and under 15 words. Body is 1-2 sentences of explanation. Each slide should naturally lead to the next.
- Slide 7: CTA slide. Drive to CleanStreak waitlist with "link in bio". Make it feel urgent/exciting, not salesy.
- visualNote: Brief art direction for each slide (layout, emphasis, icons/imagery to use).
- Write in a direct, conversational tone. No corporate speak. Think: smart friend explaining something alarming they just discovered.
- Reference specific UPF facts, ingredients, or label tricks where relevant to the topic.`,
      },
    ],
  });

  const text = message.content[0].text;
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error("Claude did not return valid JSON array. Raw:\n" + text);
  }

  const slides = JSON.parse(jsonMatch[0]);
  console.log(`  Generated ${slides.length} slides.`);
  return slides;
}

// ── Step 4: Render slides as PNGs with Puppeteer ────────────────────────────
function buildSlideHTML(slide, totalSlides) {
  const isHook = slide.slideNumber === 1;
  const isCTA = slide.slideNumber === totalSlides;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800;900&display=swap');

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    width: 1080px;
    height: 1080px;
    background: #ffffff;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    padding: 80px;
    position: relative;
    overflow: hidden;
  }

  /* Subtle streak motif — diagonal lines in background */
  body::before {
    content: '';
    position: absolute;
    top: -50%;
    left: -50%;
    width: 200%;
    height: 200%;
    background: repeating-linear-gradient(
      45deg,
      transparent,
      transparent 80px,
      rgba(34, 197, 94, 0.03) 80px,
      rgba(34, 197, 94, 0.03) 82px
    );
    pointer-events: none;
  }

  /* Green accent bar at top */
  .accent-bar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 6px;
    background: linear-gradient(90deg, #22c55e, #16a34a);
  }

  /* Slide counter */
  .slide-counter {
    position: absolute;
    top: 32px;
    right: 40px;
    font-size: 18px;
    font-weight: 600;
    color: #a3a3a3;
    letter-spacing: 1px;
  }

  /* Checkmark motif */
  .checkmark {
    position: absolute;
    bottom: 40px;
    right: 40px;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: ${isCTA ? "#22c55e" : "rgba(34, 197, 94, 0.1)"};
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .checkmark::after {
    content: '\\2713';
    color: ${isCTA ? "#fff" : "#22c55e"};
    font-size: 20px;
    font-weight: 800;
  }

  .content {
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: ${isHook || isCTA ? "center" : "flex-start"};
    text-align: ${isHook || isCTA ? "center" : "left"};
    width: 100%;
    max-width: 920px;
    z-index: 1;
  }

  .headline {
    font-size: ${isHook ? "64px" : isCTA ? "52px" : "48px"};
    font-weight: 900;
    color: #171717;
    line-height: 1.15;
    margin-bottom: ${isHook ? "0" : "32px"};
    letter-spacing: -1px;
  }

  .headline .green {
    color: #22c55e;
  }

  .body {
    font-size: ${isCTA ? "28px" : "26px"};
    font-weight: 400;
    color: #525252;
    line-height: 1.6;
    max-width: 800px;
  }

  /* CTA button style for last slide */
  .cta-button {
    margin-top: 48px;
    padding: 24px 56px;
    background: #22c55e;
    color: #fff;
    font-size: 28px;
    font-weight: 800;
    border-radius: 60px;
    letter-spacing: 0.5px;
    box-shadow: 0 8px 32px rgba(34, 197, 94, 0.3);
  }

  /* Brand name */
  .brand {
    position: absolute;
    bottom: 36px;
    left: 40px;
    font-size: 18px;
    font-weight: 800;
    color: #22c55e;
    letter-spacing: 1px;
  }

  /* Slide number dot indicator */
  .dots {
    position: absolute;
    bottom: 40px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: 8px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #e5e5e5;
  }
  .dot.active {
    background: #22c55e;
    width: 24px;
    border-radius: 4px;
  }
</style>
</head>
<body>
  <div class="accent-bar"></div>
  <div class="slide-counter">${slide.slideNumber} / ${totalSlides}</div>

  <div class="content">
    <div class="headline">${escapeHtml(slide.headline)}</div>
    ${slide.body && !isHook ? `<div class="body">${escapeHtml(slide.body)}</div>` : ""}
    ${isCTA ? `<div class="cta-button">Link in Bio</div>` : ""}
  </div>

  <div class="brand">CLEANSTREAK</div>
  <div class="checkmark"></div>
  <div class="dots">
    ${Array.from({ length: totalSlides }, (_, i) => `<div class="dot ${i === slide.slideNumber - 1 ? "active" : ""}"></div>`).join("")}
  </div>
</body>
</html>`;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function renderSlides(slides, outputDir) {
  console.log("Rendering slides with Puppeteer...");

  mkdirSync(outputDir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1080 });

  for (const slide of slides) {
    const html = buildSlideHTML(slide, slides.length);
    await page.setContent(html, { waitUntil: "networkidle0" });

    const filePath = resolve(
      outputDir,
      `slide-${String(slide.slideNumber).padStart(2, "0")}.png`
    );
    await page.screenshot({ path: filePath, type: "png" });
    console.log(`  Saved ${filePath}`);
  }

  await browser.close();

  // Also save the slide content JSON alongside PNGs
  writeFileSync(
    resolve(outputDir, "slides.json"),
    JSON.stringify(slides, null, 2)
  );
  console.log(`  Saved slides.json`);
}

// ── Step 6: Log to Posts tab in Sheets ──────────────────────────────────────
async function logToPostsTab(sheets, topic, hookText, outputDir) {
  console.log('Logging to "Posts" tab...');

  await ensureSheet(sheets, "Posts");

  // Check if header exists
  const existing = await readSheetTab(sheets, "Posts!A1:F1");
  if (existing.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEETS_ID,
      range: "Posts!A1",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [["Date", "Topic", "Hook", "Output Folder", "Status"]],
      },
    });
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEETS_ID,
    range: "Posts!A:E",
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[today(), topic, hookText, outputDir, "draft"]],
    },
  });

  console.log("  Logged draft post entry.");
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`=== CleanStreak Carousel Generator ===`);
  console.log(`Topic: "${topic}"\n`);

  // Connect to Sheets
  let sheets;
  try {
    sheets = await getSheetsClient();
  } catch (err) {
    console.error("Google Sheets auth failed:", err.message);
    console.log("Continuing without Sheets data...\n");
    sheets = null;
  }

  // 1. Load research context
  let research = null;
  let playbook = [];
  if (sheets) {
    const ctx = await loadResearchContext(sheets);
    research = ctx.localResearch;
    playbook = ctx.playbookRows;
  } else if (existsSync("./research/latest.json")) {
    research = JSON.parse(readFileSync("./research/latest.json", "utf8"));
    console.log("Loaded local research/latest.json as fallback.");
  }

  // 2. Load top performing posts
  let topPosts = [];
  if (sheets) {
    topPosts = await loadTopPerformingPosts(sheets);
  }

  // 3. Generate carousel content
  const slides = await generateCarouselContent(
    topic,
    research,
    playbook,
    topPosts
  );

  // 4. Render PNGs
  const outputDir = `./output/${today()}-${slugify(topic)}`;
  await renderSlides(slides, outputDir);

  // 5. Log to Posts tab
  if (sheets) {
    try {
      const hookText = slides[0]?.headline || "";
      await logToPostsTab(sheets, topic, hookText, outputDir);
    } catch (err) {
      console.error("Failed to log to Posts tab:", err.message);
    }
  }

  console.log(`\nDone! Carousel saved to: ${outputDir}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
