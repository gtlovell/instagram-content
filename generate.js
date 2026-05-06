import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import puppeteer from "puppeteer";
import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { resolve } from "path";
import { pathToFileURL } from "url";
import {
  CAROUSEL_SLIDE_COUNT,
  POSTS_HEADER,
  assertPngDimensions,
  ensureOutputDir,
  escapeHtml,
  finalPostText,
  getAssetCount,
  getHook,
  parseGenerateArgs,
  parseJsonResponse,
  readPngDimensions,
  today,
  validateContent,
  writeCommonOutputFiles,
} from "./lib/content-contracts.js";
import { appendObjectRow, getSheetsClient, readSheetTab } from "./lib/sheets.js";
import { requireEnv, withRetry } from "./lib/retry.js";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SHEETS_ID = process.env.SHEETS_ID;
const CREDENTIALS_PATH =
  process.env.GOOGLE_CREDENTIALS_PATH ||
  "./credentials/sheets-service-account.json";
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1.5";

const OFFER_MONTHLY_PRICE = process.env.OFFER_MONTHLY_PRICE || "$5.99/mo";
const OFFER_LIFETIME_PRICE = process.env.OFFER_LIFETIME_PRICE || "$29.99";
const OFFER_LIMIT = process.env.OFFER_LIMIT || "First 1,000 only";
const OFFER_CTA_TEXT = process.env.OFFER_CTA_TEXT || "Link in Bio";

async function maybeGetSheetsClient() {
  if (!SHEETS_ID || !existsSync(CREDENTIALS_PATH)) return null;
  try {
    return await getSheetsClient({ credentialsPath: CREDENTIALS_PATH });
  } catch (err) {
    console.log(`Google Sheets unavailable - continuing without it (${err.message}).`);
    return null;
  }
}

async function readSheetRows(sheets, range) {
  if (!sheets || !SHEETS_ID) return [];
  return readSheetTab(sheets, SHEETS_ID, range);
}

async function loadResearchContext(sheets) {
  console.log("Loading research context...");

  let localResearch = null;
  const localPath = "./research/latest.json";
  if (existsSync(localPath)) {
    localResearch = JSON.parse(readFileSync(localPath, "utf8"));
    console.log(`  Loaded local research: ${localResearch.postCount} posts`);
  }

  const playbookRows = await readSheetRows(sheets, "Playbook!A1:B250");
  console.log(`  Playbook rows: ${playbookRows.length}`);

  return { localResearch, playbookRows };
}

async function loadTopPerformingPosts(sheets) {
  if (!sheets) return [];
  console.log("Loading top performing posts from Metrics tab...");

  const rows = await readSheetRows(sheets, "Metrics!A1:Z500");
  if (rows.length < 2) return [];

  const header = rows[0].map((h) => h.toLowerCase().trim());
  const dataRows = rows.slice(1);

  const reactionsIdx = header.findIndex((h) => h.includes("reaction") || h.includes("like"));
  const commentsIdx = header.findIndex((h) => h.includes("comment"));
  const repostsIdx = header.findIndex((h) => h.includes("repost") || h.includes("share"));
  const hookIdx = header.findIndex((h) => h.includes("hook") || h.includes("headline") || h.includes("title"));
  const typeIdx = header.findIndex((h) => h.includes("content type"));

  const scored = dataRows.map((row, i) => {
    const reactions = parseInt(row[reactionsIdx] || "0", 10) || 0;
    const comments = parseInt(row[commentsIdx] || "0", 10) || 0;
    const reposts = parseInt(row[repostsIdx] || "0", 10) || 0;
    const score = reactions + comments * 3 + reposts * 5;
    return {
      index: i,
      score,
      hook: hookIdx >= 0 ? row[hookIdx] || "" : "",
      contentType: typeIdx >= 0 ? row[typeIdx] || "carousel" : "carousel",
      raw: Object.fromEntries(header.map((h, j) => [h, row[j] || ""])),
    };
  });

  scored.sort((a, b) => b.score - a.score);
  const top3 = scored.slice(0, 3);
  console.log(`  Top 3 posts (scores: ${top3.map((p) => p.score).join(", ") || "none"})`);
  return top3;
}

function buildContextText({ research, playbook, topPosts }) {
  const playbookText = playbook.map((r) => r.join(" | ")).join("\n") || "No playbook available yet.";
  const topPostsText = topPosts.length
    ? topPosts
        .map((p, i) => `#${i + 1} ${p.contentType} (score ${p.score}): Hook: "${p.hook}" | ${JSON.stringify(p.raw)}`)
        .join("\n")
    : "No past metrics data yet.";
  const researchAnalysis = research?.analysis
    ? JSON.stringify(research.analysis, null, 2)
    : "No research analysis available.";
  const researchPosts = research?.posts
    ? `Top performing scraped LinkedIn posts:\n${research.posts
        .sort((a, b) => (b.engagementScore || 0) - (a.engagementScore || 0))
        .slice(0, 8)
        .map(
          (p) => `---
@${p.authorName} | ${p.authorTitle} | ${p.authorFollowers} followers
Likes: ${p.likes} | Comments: ${p.comments} | Reposts: ${p.reposts}
Type: ${p.postType}
Full text (first 600 chars): ${p.text.slice(0, 600)}
---`
        )
        .join("\n")}`
    : "No scraped post examples available.";

  return { playbookText, topPostsText, researchAnalysis, researchPosts };
}

function promptForType(type, topic, context) {
  const base = `You create LinkedIn content for CleanStreak, an ultra-processed food tracking app with a barcode scanner and streak mechanic.

TARGET AUDIENCE: Health-conscious professionals aged 28-50. Nutritionists, dietitians, fitness coaches, corporate wellness advocates, educated parents, and general professionals who follow wellness content.

TOPIC: "${topic}"

=== RESEARCH ===
${context.researchAnalysis}

=== TOP SCRAPED LINKEDIN POSTS ===
${context.researchPosts}

=== PLAYBOOK ===
${context.playbookText}

=== OUR TOP PAST PERFORMERS ===
${context.topPostsText}

GLOBAL RULES:
- Write like an expert sharing a finding, not like an ad.
- No corporate speak. No buzzwords like "empower" or "leverage".
- Use plain language.
- Specific beats general.
- Never use abbreviations UPF, NOVA, HFCS. Spell them out plainly.
- No em dashes.
- Return ONLY valid JSON. No markdown fences.`;

  if (type === "carousel") {
    return `${base}

Generate an exactly ${CAROUSEL_SLIDE_COUNT}-slide LinkedIn document carousel.

JSON shape:
{
  "slides": [
    { "slideNumber": 1, "headline": "...", "body": "...", "visualNote": "..." }
  ],
  "caption": "..."
}

SLIDE RULES:
- Slide 1: Hook. Headline max 10 words, no punctuation after headline. Body is one sentence.
- Slides 2-6: One insight per slide. Headline max 9 words. Body is one to two short sentences.
- Slide 7: CleanStreak bridge. Name barcode scanner, instant verdict, or streak tracking. Discovery framing, not a sales pitch.
- Slide 8: Offer only. Headline must be: "At launch it's ${OFFER_MONTHLY_PRICE}. Right now it's ${OFFER_LIFETIME_PRICE}. Forever." Body must be: "${OFFER_LIMIT}. No payment today."
- At least one insight slide should naturally reference CleanStreak in first-person discovery framing.

CAPTION RULES:
- Max 700 characters including hashtags.
- Aggressive line breaks for mobile.
- Include: "I built CleanStreak to solve this."
- Include: "Comment SCAN and I'll send you the link."
- 5-7 hashtags, including #ultraprocessedfood #foodlabels #cleanstreak #nutritionlabel`;
  }

  if (type === "post") {
    return `${base}

Generate a text-only LinkedIn post.

JSON shape:
{
  "hook": "...",
  "body": "...",
  "cta": "...",
  "hashtags": ["#...", "#..."]
}

POST RULES:
- Hook is a strong first line under 95 characters.
- Body is 120-500 words with short paragraphs and real line breaks.
- Include one concrete CleanStreak bridge, but do not sound like an ad.
- CTA should be comment-driven or save-driven.
- Hashtags: 5-7 tags, including #ultraprocessedfood #foodlabels #cleanstreak #nutritionlabel.`;
  }

  return `${base}

Generate copy and an image-generation prompt for a single-image LinkedIn post.

JSON shape:
{
  "headline": "...",
  "subheadline": "...",
  "caption": "...",
  "imagePrompt": "...",
  "altText": "..."
}

IMAGE POST RULES:
- Headline max 9 words. It will be rendered as crisp overlay text locally.
- Subheadline max 18 words.
- Caption max 700 characters and include line breaks, a CleanStreak bridge, and hashtags.
- Image prompt should describe a premium, realistic editorial visual without asking the model to render readable text.
- Image should be portrait-oriented, LinkedIn-ready, and related to the topic through food labels, grocery context, barcode scanning, or ingredient discovery.`;
}

async function generateContentWithClaude(type, topic, context) {
  requireEnv("ANTHROPIC_API_KEY", "content generation");
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  console.log(`Generating ${type} content with Claude...`);

  const message = await withRetry(`Claude ${type} generation`, () =>
    anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      max_tokens: type === "post" ? 5000 : 8096,
      messages: [{ role: "user", content: promptForType(type, topic, context) }],
    })
  );

  const text = message.content[0].text;
  const content = parseJsonResponse(type, text);
  return validateContent(type, content);
}

function buildSlideHTML(slide, totalSlides) {
  const isHook = slide.slideNumber === 1;
  const isCTA = slide.slideNumber === totalSlides;
  const isBridge = slide.slideNumber === totalSlides - 1;
  const ACCENT = "#0A66C2";
  const ACCENT2 = "#057642";
  const BG = isHook ? "#0A0A0A" : isCTA ? "#0A0A0A" : "#FFFFFF";
  const TEXT = isHook || isCTA ? "#F5F5F5" : "#171717";
  const SUBTEXT = isHook || isCTA ? "#A3A3A3" : "#525252";
  const barColor = isHook ? ACCENT : isCTA ? ACCENT2 : ACCENT;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1080px; height: 1350px; background: ${BG};
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    display: flex; flex-direction: column; position: relative; overflow: hidden;
  }
  .accent-bar { position: absolute; top: 0; left: 0; right: 0; height: 8px; background: linear-gradient(90deg, ${barColor}, ${isCTA ? "#059669" : "#0077B5"}); }
  .counter { position: absolute; top: 36px; right: 48px; font-size: 20px; font-weight: 600; color: ${isHook || isCTA ? "#555" : "#C0C0C0"}; letter-spacing: 1.5px; }
  .content { flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: ${isHook || isCTA ? "center" : "flex-start"}; text-align: ${isHook || isCTA ? "center" : "left"}; padding: ${isHook || isCTA ? "80px 72px" : "80px 72px 60px"}; z-index: 1; }
  .tag-pill { display: inline-flex; padding: 8px 20px; border-radius: 100px; font-size: 16px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; margin-bottom: 36px; background: ${isHook ? "rgba(10,102,194,0.25)" : isCTA ? "rgba(5,118,66,0.25)" : "rgba(10,102,194,0.06)"}; color: ${isHook ? "#60A5FA" : isCTA ? "#4ADE80" : ACCENT}; border: 1px solid ${isHook ? "rgba(96,165,250,0.3)" : isCTA ? "rgba(74,222,128,0.3)" : "rgba(10,102,194,0.15)"}; }
  .headline { font-size: ${isHook ? "88px" : isCTA ? "64px" : "72px"}; font-weight: 900; color: ${TEXT}; line-height: 1.05; letter-spacing: 0; margin-bottom: 40px; max-width: 920px; }
  .body { font-size: ${isCTA ? "40px" : "38px"}; font-weight: ${isCTA ? "500" : "400"}; color: ${SUBTEXT}; line-height: 1.55; max-width: 860px; }
  .cta-btn { margin-top: 56px; padding: 28px 64px; background: #057642; color: #fff; font-size: 28px; font-weight: 800; border-radius: 60px; box-shadow: 0 10px 40px rgba(5,118,66,0.35); }
  .divider { width: 60px; height: 4px; background: ${ACCENT}; border-radius: 2px; margin-bottom: 40px; }
  .footer { display: flex; align-items: center; justify-content: space-between; padding: 28px 72px; border-top: 1px solid ${isHook || isCTA ? "rgba(255,255,255,0.08)" : "#F0F0F0"}; z-index: 1; }
  .brand-name { font-size: 20px; font-weight: 800; color: ${ACCENT2}; letter-spacing: 1px; text-transform: uppercase; }
  .dots { display: flex; gap: 8px; align-items: center; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: ${isHook || isCTA ? "#333" : "#E5E5E5"}; }
  .dot.active { background: ${ACCENT}; width: 24px; border-radius: 4px; }
  .swipe-hint { font-size: 18px; font-weight: 600; color: #555; letter-spacing: 0.5px; }
  ${isHook || isCTA ? `body::before { content: ''; position: absolute; inset: 0; background: radial-gradient(ellipse at 20% 50%, rgba(10,102,194,0.12) 0%, transparent 60%), radial-gradient(ellipse at 80% 50%, rgba(5,118,66,0.08) 0%, transparent 60%); pointer-events: none; }` : ""}
</style>
</head>
<body>
  <div class="accent-bar"></div>
  <span class="counter">${slide.slideNumber} / ${totalSlides}</span>
  <div class="content">
    <div class="tag-pill">${isHook ? "INSIGHT" : isCTA ? "OFFER" : isBridge ? "SOLUTION" : `SLIDE ${slide.slideNumber}`}</div>
    ${!isHook && !isCTA ? `<div class="divider"></div>` : ""}
    <div class="headline">${escapeHtml(slide.headline)}</div>
    ${slide.body ? `<div class="body">${escapeHtml(slide.body)}</div>` : ""}
    ${isCTA ? `<div class="cta-btn">${escapeHtml(OFFER_CTA_TEXT)}</div>` : ""}
  </div>
  <div class="footer">
    <div class="brand-name">CleanStreak</div>
    ${isHook ? `<span class="swipe-hint">Swipe -></span>` : ""}
    <div class="dots">${Array.from({ length: totalSlides }, (_, i) => `<div class="dot ${i === slide.slideNumber - 1 ? "active" : ""}"></div>`).join("")}</div>
  </div>
</body>
</html>`;
}

async function createPuppeteerPage(width = 1080, height = 1350) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-zygote"],
    timeout: 60000,
  });
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  return { browser, page };
}

async function renderCarousel(content, outputDir) {
  console.log("Rendering carousel slides (1080x1350)...");
  const files = [];
  const { browser, page } = await createPuppeteerPage();

  for (const slide of content.slides) {
    await page.setContent(buildSlideHTML(slide, content.slides.length), { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const filePath = resolve(outputDir, `slide-${String(slide.slideNumber).padStart(2, "0")}.png`);
    await page.screenshot({ path: filePath, type: "png" });
    assertPngDimensions(filePath, 1080, 1350, 25 * 1024);
    files.push(filePath);
    console.log(`  Saved ${filePath} (${Math.round(statSync(filePath).size / 1024)} KB)`);
  }

  await browser.close();
  return files;
}

async function generateOpenAiImage(content, outputDir) {
  requireEnv("OPENAI_API_KEY", "single-image generation");
  console.log(`Generating raw image with OpenAI Images (${OPENAI_IMAGE_MODEL})...`);

  const res = await withRetry("OpenAI image generation", () =>
    fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_IMAGE_MODEL,
        prompt: content.imagePrompt,
        size: "1024x1536",
        quality: process.env.OPENAI_IMAGE_QUALITY || "medium",
        output_format: "png",
        n: 1,
      }),
    })
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI Images API ${res.status}: ${body}`);
  }

  const payload = await res.json();
  const image = payload.data?.[0];
  if (!image?.b64_json && !image?.url) {
    throw new Error("OpenAI Images API returned no image data.");
  }

  const rawPath = resolve(outputDir, "image-raw.png");
  if (image.b64_json) {
    writeFileSync(rawPath, Buffer.from(image.b64_json, "base64"));
  } else {
    const imageRes = await withRetry("Download OpenAI image URL", () => fetch(image.url));
    if (!imageRes.ok) throw new Error(`Failed to download generated image: ${imageRes.status}`);
    writeFileSync(rawPath, Buffer.from(await imageRes.arrayBuffer()));
  }

  const dimensions = readPngDimensions(readFileSync(rawPath));
  if (dimensions.width < 900 || dimensions.height < 1200) {
    throw new Error(`Raw image is ${dimensions.width}x${dimensions.height}; expected portrait image at least 900x1200.`);
  }

  writeFileSync(resolve(outputDir, "image-prompt.txt"), content.imagePrompt);
  return rawPath;
}

function buildImagePostHTML(content, rawPath) {
  const imageUrl = pathToFileURL(rawPath).href;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@500;700;800;900&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { width: 1080px; height: 1350px; overflow: hidden; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; position: relative; background: #111; }
  img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .shade { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,.18) 0%, rgba(0,0,0,.24) 42%, rgba(0,0,0,.78) 100%); }
  .brand { position: absolute; top: 48px; left: 56px; color: #fff; font-size: 22px; font-weight: 900; letter-spacing: 1px; text-transform: uppercase; }
  .panel { position: absolute; left: 56px; right: 56px; bottom: 56px; color: #fff; }
  .headline { font-size: 76px; line-height: 1.02; font-weight: 900; letter-spacing: 0; max-width: 900px; text-wrap: balance; }
  .subheadline { margin-top: 28px; font-size: 34px; line-height: 1.32; font-weight: 600; max-width: 790px; color: rgba(255,255,255,.86); }
  .footer { margin-top: 40px; display: flex; align-items: center; gap: 18px; font-size: 24px; font-weight: 800; color: #4ADE80; }
  .dot { width: 12px; height: 12px; border-radius: 99px; background: #4ADE80; box-shadow: 0 0 22px rgba(74,222,128,.65); }
</style>
</head>
<body>
  <img src="${imageUrl}" alt="">
  <div class="shade"></div>
  <div class="brand">CleanStreak</div>
  <div class="panel">
    <div class="headline">${escapeHtml(content.headline)}</div>
    <div class="subheadline">${escapeHtml(content.subheadline)}</div>
    <div class="footer"><span class="dot"></span><span>Scan before you buy</span></div>
  </div>
</body>
</html>`;
}

async function renderImagePost(content, outputDir) {
  const rawPath = await generateOpenAiImage(content, outputDir);
  const finalPath = resolve(outputDir, "image-final.png");
  console.log("Rendering final image post overlay...");

  const { browser, page } = await createPuppeteerPage();
  await page.setContent(buildImagePostHTML(content, rawPath), { waitUntil: "load", timeout: 60000 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await page.screenshot({ path: finalPath, type: "png" });
  await browser.close();

  assertPngDimensions(finalPath, 1080, 1350, 50 * 1024);
  return [rawPath, finalPath, resolve(outputDir, "image-prompt.txt")];
}

async function writeTextPost(content, outputDir) {
  const filePath = resolve(outputDir, "post.txt");
  writeFileSync(filePath, finalPostText(content));
  console.log(`  Saved ${filePath}`);
  return [filePath];
}

async function renderContent(type, content, outputDir) {
  if (type === "carousel") return renderCarousel(content, outputDir);
  if (type === "post") return writeTextPost(content, outputDir);
  if (type === "image") return renderImagePost(content, outputDir);
  throw new Error(`Unsupported content type: ${type}`);
}

async function logDraftToPostsTab(sheets, { type, topic, content, outputDir, manifestPath, captionPath }) {
  if (!sheets || !SHEETS_ID) return;
  console.log('Logging draft to "Posts" tab...');
  await appendObjectRow(sheets, SHEETS_ID, "Posts", POSTS_HEADER, {
    date: today(),
    topic,
    hook: getHook(type, content),
    output_folder: outputDir,
    status: "draft",
    post_url: "",
    content_type: type,
    asset_count: getAssetCount(type, content),
    caption_path: captionPath,
    manifest_path: manifestPath,
    image_prompt_path: type === "image" ? resolve(outputDir, "image-prompt.txt") : "",
  });
  console.log("  Logged draft entry.");
}

export async function main(argv = process.argv.slice(2)) {
  const { type, topic } = parseGenerateArgs(argv);
  console.log(`=== CleanStreak LinkedIn ${type} Generator ===`);
  console.log(`Topic: "${topic}"\n`);

  requireEnv("ANTHROPIC_API_KEY", "content generation");
  if (type === "image") requireEnv("OPENAI_API_KEY", "single-image generation");

  const sheets = await maybeGetSheetsClient();
  const { localResearch, playbookRows } = await loadResearchContext(sheets);
  const topPosts = await loadTopPerformingPosts(sheets);
  const context = buildContextText({ research: localResearch, playbook: playbookRows, topPosts });

  const content = await generateContentWithClaude(type, topic, context);
  const outputDir = ensureOutputDir(topic, type);
  const renderedFiles = await renderContent(type, content, outputDir);
  const { manifestPath, contentPath, captionPath } = writeCommonOutputFiles({
    type,
    topic,
    outputDir,
    content,
    files: renderedFiles.map((file) => resolve(file)),
  });

  await logDraftToPostsTab(sheets, { type, topic, content, outputDir, manifestPath, captionPath });

  console.log(`\nDone! ${type} saved to: ${outputDir}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Content: ${contentPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
  });
}
