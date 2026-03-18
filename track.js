import "dotenv/config";
import { google } from "googleapis";
import { readFileSync } from "fs";

// ── Config ──────────────────────────────────────────────────────────────────
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_IG_ACCOUNT_ID = process.env.META_IG_ACCOUNT_ID;
const SHEETS_ID = process.env.SHEETS_ID;
const CREDENTIALS_PATH =
  process.env.GOOGLE_CREDENTIALS_PATH ||
  "./credentials/sheets-service-account.json";

const MEDIA_METRICS = [
  "impressions",
  "reach",
  "likes",
  "comments",
  "saved",
  "shares",
  "profile_visits",
  "follows",
];

// ── Google Sheets ───────────────────────────────────────────────────────────
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

// ── Meta Graph API ──────────────────────────────────────────────────────────
async function graphGet(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Graph API ${res.status}: ${body}`);
  }
  return res.json();
}

function extractMediaId(postUrl) {
  // Extract shortcode from URL like https://www.instagram.com/p/ABC123/
  // or https://www.instagram.com/reel/ABC123/
  const match = postUrl.match(/\/(p|reel|tv)\/([A-Za-z0-9_-]+)/);
  return match ? match[2] : null;
}

async function resolveMediaId(postUrl) {
  const shortcode = extractMediaId(postUrl);
  if (!shortcode) {
    throw new Error(`Cannot extract shortcode from URL: ${postUrl}`);
  }

  // Search recent media on the account to find the matching media ID
  const url =
    `https://graph.facebook.com/v21.0/${META_IG_ACCOUNT_ID}/media` +
    `?fields=id,shortcode,permalink,timestamp,media_type,caption` +
    `&limit=50` +
    `&access_token=${META_ACCESS_TOKEN}`;

  let nextUrl = url;
  while (nextUrl) {
    const data = await graphGet(nextUrl);
    for (const media of data.data || []) {
      if (
        media.shortcode === shortcode ||
        (media.permalink && media.permalink.includes(shortcode))
      ) {
        return media;
      }
    }
    nextUrl = data.paging?.next || null;
  }

  throw new Error(
    `Could not find media with shortcode "${shortcode}" on account ${META_IG_ACCOUNT_ID}. ` +
      `Make sure the post belongs to this account and the token has instagram_basic permission.`
  );
}

async function fetchMediaMetrics(mediaId, mediaType) {
  // Different media types support different metrics
  const isReel = mediaType === "VIDEO" || mediaType === "REELS";
  const isCarousel = mediaType === "CAROUSEL_ALBUM";
  const isStory = mediaType === "STORY";

  // Build metric list based on what the API supports per type
  let metricList;
  if (isReel) {
    metricList = ["impressions", "reach", "likes", "comments", "saved", "shares", "plays"];
  } else if (isCarousel) {
    metricList = ["impressions", "reach", "likes", "comments", "saved", "shares"];
  } else if (isStory) {
    metricList = ["impressions", "reach"];
  } else {
    // IMAGE / standard post
    metricList = ["impressions", "reach", "likes", "comments", "saved", "shares", "profile_visits", "follows"];
  }

  const url =
    `https://graph.facebook.com/v21.0/${mediaId}/insights` +
    `?metric=${metricList.join(",")}` +
    `&access_token=${META_ACCESS_TOKEN}`;

  let insightsData;
  try {
    insightsData = await graphGet(url);
  } catch (err) {
    // If some metrics fail, try with a minimal set
    console.warn(`  Full metrics failed, trying basic set: ${err.message}`);
    const fallbackMetrics = ["impressions", "reach"];
    const fallbackUrl =
      `https://graph.facebook.com/v21.0/${mediaId}/insights` +
      `?metric=${fallbackMetrics.join(",")}` +
      `&access_token=${META_ACCESS_TOKEN}`;
    insightsData = await graphGet(fallbackUrl);
  }

  const metrics = {};
  for (const item of insightsData.data || []) {
    metrics[item.name] = item.values?.[0]?.value ?? 0;
  }

  // Also fetch basic fields (likes/comments from the media object itself as fallback)
  const fieldsUrl =
    `https://graph.facebook.com/v21.0/${mediaId}` +
    `?fields=like_count,comments_count,timestamp,permalink,media_type,caption` +
    `&access_token=${META_ACCESS_TOKEN}`;

  try {
    const fields = await graphGet(fieldsUrl);
    if (!metrics.likes && fields.like_count != null) metrics.likes = fields.like_count;
    if (!metrics.comments && fields.comments_count != null) metrics.comments = fields.comments_count;
    metrics._timestamp = fields.timestamp || null;
    metrics._permalink = fields.permalink || null;
    metrics._media_type = fields.media_type || null;
    metrics._caption = fields.caption || null;
  } catch {
    // Non-critical, continue with what we have
  }

  return metrics;
}

// ── Posts tab helpers ────────────────────────────────────────────────────────
const POSTS_HEADER = ["Date", "Topic", "Hook", "Output Folder", "Status", "Post URL"];

async function loadPostsTab(sheets) {
  await ensureSheet(sheets, "Posts");
  const rows = await readSheetTab(sheets, "Posts!A1:F500");

  if (rows.length === 0) {
    // Write header
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEETS_ID,
      range: "Posts!A1",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [POSTS_HEADER] },
    });
    return { header: POSTS_HEADER, rows: [] };
  }

  return { header: rows[0], rows: rows.slice(1) };
}

function findColIndex(header, ...candidates) {
  const lower = header.map((h) => (h || "").toLowerCase().replace(/[_\s]/g, ""));
  for (const c of candidates) {
    const norm = c.toLowerCase().replace(/[_\s]/g, "");
    const idx = lower.findIndex((h) => h.includes(norm));
    if (idx >= 0) return idx;
  }
  return -1;
}

async function findOrAssignPostRow(sheets, postsData, postUrl) {
  const { header, rows } = postsData;
  const urlIdx = findColIndex(header, "post_url", "posturl", "url");
  const statusIdx = findColIndex(header, "status");

  // Ensure Post URL column exists
  let actualUrlIdx = urlIdx;
  if (actualUrlIdx < 0) {
    actualUrlIdx = header.length;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEETS_ID,
      range: `Posts!${colLetter(actualUrlIdx)}1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[POSTS_HEADER[5]]] },
    });
    header.push(POSTS_HEADER[5]);
  }

  // Search for matching URL
  for (let i = 0; i < rows.length; i++) {
    const rowUrl = (rows[i][actualUrlIdx] || "").trim();
    if (rowUrl === postUrl) {
      return { rowIndex: i, sheetRow: i + 2, isNew: false }; // +2 for header + 0-index
    }
  }

  // Search for a draft row without a URL (assign this URL to it)
  for (let i = 0; i < rows.length; i++) {
    const rowUrl = (rows[i][actualUrlIdx] || "").trim();
    const rowStatus = (rows[i][statusIdx] || "").trim().toLowerCase();
    if (!rowUrl && rowStatus === "draft") {
      return { rowIndex: i, sheetRow: i + 2, isNew: false, needsUrl: true };
    }
  }

  // No matching row found — return null so caller can decide
  return null;
}

function colLetter(idx) {
  let letter = "";
  let n = idx;
  while (n >= 0) {
    letter = String.fromCharCode(65 + (n % 26)) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

async function updatePostsRow(sheets, sheetRow, header, postUrl, status) {
  const urlIdx = findColIndex(header, "post_url", "posturl", "url");
  const statusIdx = findColIndex(header, "status");

  const updates = [];
  if (urlIdx >= 0) {
    updates.push({
      range: `Posts!${colLetter(urlIdx)}${sheetRow}`,
      values: [[postUrl]],
    });
  }
  if (statusIdx >= 0) {
    updates.push({
      range: `Posts!${colLetter(statusIdx)}${sheetRow}`,
      values: [[status]],
    });
  }

  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEETS_ID,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: updates,
      },
    });
  }
}

// ── Metrics tab ─────────────────────────────────────────────────────────────
const METRICS_HEADER = [
  "Post URL",
  "Date Posted",
  "Date Tracked",
  "Media Type",
  "Impressions",
  "Reach",
  "Likes",
  "Comments",
  "Saves",
  "Shares",
  "Profile Visits",
  "Follows",
  "Plays",
  "Hook",
];

async function ensureMetricsHeader(sheets) {
  await ensureSheet(sheets, "Metrics");
  const existing = await readSheetTab(sheets, "Metrics!A1:N1");
  if (existing.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEETS_ID,
      range: "Metrics!A1",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [METRICS_HEADER] },
    });
  }
}

async function writeMetricsRow(sheets, postUrl, metrics) {
  await ensureMetricsHeader(sheets);

  const datePosted = metrics._timestamp
    ? new Date(metrics._timestamp).toISOString().slice(0, 10)
    : "";
  const dateTracked = new Date().toISOString().slice(0, 10);
  const hook = (metrics._caption || "").split("\n")[0].slice(0, 120);

  const row = [
    postUrl,
    datePosted,
    dateTracked,
    metrics._media_type || "",
    metrics.impressions ?? "",
    metrics.reach ?? "",
    metrics.likes ?? "",
    metrics.comments ?? "",
    metrics.saved ?? "",
    metrics.shares ?? "",
    metrics.profile_visits ?? "",
    metrics.follows ?? "",
    metrics.plays ?? "",
    hook,
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEETS_ID,
    range: "Metrics!A:N",
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });

  return { datePosted, dateTracked };
}

// ── Track a single post ─────────────────────────────────────────────────────
async function trackPost(sheets, postUrl, postsData) {
  console.log(`\nTracking: ${postUrl}`);

  // 1. Resolve the IG media ID from the URL
  console.log("  Resolving media ID...");
  const media = await resolveMediaId(postUrl);
  console.log(`  Found: ${media.id} (${media.media_type || "unknown type"})`);

  // 2. Fetch metrics
  console.log("  Fetching metrics...");
  const metrics = await fetchMediaMetrics(media.id, media.media_type);

  const display = Object.entries(metrics)
    .filter(([k]) => !k.startsWith("_"))
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  console.log(`  Metrics: ${display}`);

  // 3. Write to Metrics tab
  const { dateTracked } = await writeMetricsRow(sheets, postUrl, metrics);
  console.log(`  Written to Metrics tab (tracked ${dateTracked})`);

  // 4. Update Posts tab
  if (postsData) {
    const match = await findOrAssignPostRow(sheets, postsData, postUrl);
    if (match) {
      await updatePostsRow(
        sheets,
        match.sheetRow,
        postsData.header,
        postUrl,
        "posted"
      );
      console.log(`  Posts tab row ${match.sheetRow} updated → "posted"`);
    } else {
      console.log("  No matching draft row in Posts tab (skipped update).");
    }
  }

  return metrics;
}

// ── Track all posted ────────────────────────────────────────────────────────
async function trackAll(sheets) {
  console.log("Fetching all posted entries from Posts tab...\n");

  const postsData = await loadPostsTab(sheets);
  const { header, rows } = postsData;

  const statusIdx = findColIndex(header, "status");
  const urlIdx = findColIndex(header, "post_url", "posturl", "url");

  if (urlIdx < 0) {
    console.log("No Post URL column found in Posts tab. Nothing to track.");
    return;
  }

  const postedRows = rows.filter((row) => {
    const status = (row[statusIdx] || "").trim().toLowerCase();
    const url = (row[urlIdx] || "").trim();
    return status === "posted" && url;
  });

  if (postedRows.length === 0) {
    console.log('No rows with status "posted" found. Nothing to track.');
    return;
  }

  console.log(`Found ${postedRows.length} posted entries to track.\n`);

  let success = 0;
  let failed = 0;

  for (const row of postedRows) {
    const url = row[urlIdx].trim();
    try {
      await trackPost(sheets, url, null); // skip Posts tab update, already posted
      success++;
    } catch (err) {
      console.error(`  FAILED for ${url}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone. Tracked: ${success}, Failed: ${failed}`);
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const arg = process.argv[2];

  if (!arg) {
    console.error(
      "Usage:\n" +
        '  node track.js <instagram-post-url>   Track a single post\n' +
        "  node track.js --all                   Re-fetch metrics for all posted entries"
    );
    process.exit(1);
  }

  if (!META_ACCESS_TOKEN || !META_IG_ACCOUNT_ID) {
    console.error(
      "Missing env vars: META_ACCESS_TOKEN and META_IG_ACCOUNT_ID are required."
    );
    process.exit(1);
  }

  console.log("=== CleanStreak Instagram Performance Tracker ===\n");

  const sheets = await getSheetsClient();

  if (arg === "--all") {
    await trackAll(sheets);
  } else {
    // Single post URL
    const postUrl = arg.trim();
    if (!postUrl.includes("instagram.com")) {
      console.error("Argument doesn't look like an Instagram URL.");
      process.exit(1);
    }

    const postsData = await loadPostsTab(sheets);
    await trackPost(sheets, postUrl, postsData);
    console.log("\nDone!");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
